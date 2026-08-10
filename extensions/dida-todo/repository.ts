import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { decodeWorkTask, encodeManagedContent, metadataToItems, synchronizeItemIds } from "./codec.js";
import type {
  DidaProjectData,
  DidaTask,
  Task,
  TaskStatus,
  TodoScope,
  WorkMetadata,
  WorkTask,
} from "./domain.js";
import { buildCompletionReminderInput } from "./scheduling.js";
import { buildAcceptanceSummary, buildAcceptanceTaskInput, classifyAcceptanceTask, type DidaComment } from "./acceptance.js";

export interface DidaGateway {
  getProjectData(projectId: string, signal?: AbortSignal): Promise<DidaProjectData>;
  getTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<DidaTask>;
  createTask(input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
  updateTask(taskId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
  completeTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<void>;
  addTaskComment?(projectId: string, taskId: string, title: string, signal?: AbortSignal): Promise<void>;
  getTaskComments?(projectId: string, taskId: string, signal?: AbortSignal): Promise<DidaComment[]>;
}

export interface PendingAcceptance {
  remote: DidaTask;
  comments: DidaComment[];
}

export interface SyncOpenWorksResult {
  works: WorkTask[];
  adoptedWorkIds: string[];
  acceptances: PendingAcceptance[];
}

export interface FinishWorkResult {
  acceptanceTask: DidaTask;
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  activeForm?: string;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  };
}

function taskQueueKey(scope: TodoScope, workId: string): string {
  return `/tmp/pi-dida-todo-${scope.binding.projectId}-${workId}.lock`;
}

export class DidaTodoRepository {
  constructor(private readonly gateway: DidaGateway) {}

  async listOpenWorks(scope: TodoScope, signal?: AbortSignal): Promise<WorkTask[]> {
    return (await this.syncOpenWorks(scope, { adoptUnmanaged: false }, signal)).works;
  }

  async syncOpenWorks(
    scope: TodoScope,
    options: { adoptUnmanaged: boolean },
    signal?: AbortSignal,
  ): Promise<SyncOpenWorksResult> {
    const data = await this.gateway.getProjectData(scope.binding.projectId, signal);
    const works: WorkTask[] = [];
    const adoptedWorkIds: string[] = [];
    const acceptances: PendingAcceptance[] = [];
    for (const remote of data.tasks) {
      if (remote.tags?.includes("pi-todo-reminder")) continue;
      if (classifyAcceptanceTask(remote)) {
        const comments = this.gateway.getTaskComments
          ? await this.gateway.getTaskComments(scope.binding.projectId, remote.id, signal)
          : [];
        acceptances.push({ remote, comments });
        continue;
      }
      let work = decodeWorkTask(remote);
      if (work) {
        if (work.metadata.bindingKey === scope.bindingKey) works.push(work);
        continue;
      }
      if (!options.adoptUnmanaged || remote.status !== 0 || remote.tags?.includes("pi-todo-reminder")) continue;
      work = await this.adoptRemoteTask(scope, remote, signal);
      works.push(work);
      adoptedWorkIds.push(remote.id);
    }
    works.sort((a, b) => String(b.remote.createdTime ?? "").localeCompare(String(a.remote.createdTime ?? "")));
    return { works, adoptedWorkIds, acceptances };
  }

  async getWork(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<WorkTask> {
    const remote = await this.gateway.getTask(scope.binding.projectId, workId, signal);
    const work = decodeWorkTask(remote);
    if (!work) throw new Error(`滴答任务 ${workId} 不是 Pi Todo 工作任务`);
    if (work.metadata.bindingKey !== scope.bindingKey) throw new Error(`滴答任务 ${workId} 不属于当前项目绑定`);
    return work;
  }

  async adoptWork(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<WorkTask> {
    const remote = await this.gateway.getTask(scope.binding.projectId, workId, signal);
    if (remote.status !== 0) throw new Error(`只能接管未完成的滴答任务: ${workId}`);
    if (decodeWorkTask(remote)) return this.getWork(scope, workId, signal);
    return this.adoptRemoteTask(scope, remote, signal);
  }

  async addProgressComment(scope: TodoScope, workId: string, title: string, signal?: AbortSignal): Promise<void> {
    if (!this.gateway.addTaskComment) return;
    await this.gateway.addTaskComment(scope.binding.projectId, workId, title, signal);
  }

  async createAcceptanceTask(
    scope: TodoScope,
    workId: string,
    minutes: number,
    summary: string,
    signal?: AbortSignal,
  ): Promise<DidaTask> {
    const work = await this.getWork(scope, workId, signal);
    return this.gateway.createTask(buildAcceptanceTaskInput(work.remote, minutes, summary), signal);
  }

  async scheduleCompletionReminder(
    scope: TodoScope,
    workId: string,
    minutes: number,
    signal?: AbortSignal,
  ): Promise<DidaTask> {
    const work = await this.getWork(scope, workId, signal);
    return this.gateway.createTask(buildCompletionReminderInput(work.remote, minutes), signal);
  }

  private async adoptRemoteTask(scope: TodoScope, remote: DidaTask, signal?: AbortSignal): Promise<WorkTask> {
    const tasks: Task[] = (remote.items ?? []).map((item, index) => ({
      id: index + 1,
      subject: item.title,
      status: item.status === 1 || item.status === 2 ? "completed" : "pending",
      ...(item.id ? { itemId: item.id } : {}),
      metadata: { source: "dida" },
    }));
    let metadata: WorkMetadata = {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: tasks.length + 1,
      tasks,
      sessionIds: [scope.sessionId],
      ...(scope.tmuxTarget ? { tmuxTarget: scope.tmuxTarget } : {}),
      cwd: scope.cwd,
    };
    metadata = synchronizeItemIds(metadata, remote);
    const updated = await this.gateway.updateTask(
      remote.id,
      this.buildUpdateInput(remote, metadata, remote.content ?? ""),
      signal,
    );
    const work = decodeWorkTask(updated);
    if (!work) throw new Error(`无法接管滴答工作任务: ${remote.id}`);
    return work;
  }

  async createWork(scope: TodoScope, title: string, signal?: AbortSignal): Promise<WorkTask> {
    if (!title.trim()) throw new Error("工作任务标题不能为空");
    const metadata: WorkMetadata = {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 1,
      tasks: [],
      sessionIds: [scope.sessionId],
      ...(scope.tmuxTarget ? { tmuxTarget: scope.tmuxTarget } : {}),
      cwd: scope.cwd,
    };
    let remote = await this.gateway.createTask(
      {
        title: title.trim(),
        projectId: scope.binding.projectId,
        content: encodeManagedContent("", metadata),
        items: [],
        tags: ["pi-todo"],
      },
      signal,
    );
    const synced = synchronizeItemIds(metadata, remote);
    remote = await this.gateway.updateTask(
      remote.id,
      this.buildUpdateInput(remote, synced, ""),
      signal,
    );
    return decodeWorkTask(remote) ?? { remote, metadata: synced, tasks: synced.tasks, userContent: "" };
  }

  async createTask(scope: TodoScope, workId: string, input: CreateTaskInput, signal?: AbortSignal): Promise<WorkTask> {
    if (!input.subject.trim()) throw new Error("subject required for create");
    return this.mutate(scope, workId, signal, async (work) => {
      for (const id of input.blockedBy ?? []) this.requireDependency(work.tasks, id, "blockedBy");
      const task: Task = {
        id: work.metadata.nextId,
        subject: input.subject.trim(),
        status: "pending",
        ...(input.description ? { description: input.description } : {}),
        ...(input.activeForm ? { activeForm: input.activeForm } : {}),
        ...(input.blockedBy?.length ? { blockedBy: [...input.blockedBy] } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      };
      return {
        ...work.metadata,
        nextId: work.metadata.nextId + 1,
        tasks: [...work.tasks.map(cloneTask), task],
      };
    });
  }

  async updateTask(
    scope: TodoScope,
    workId: string,
    id: number,
    input: UpdateTaskInput,
    signal?: AbortSignal,
  ): Promise<WorkTask> {
    return this.mutate(scope, workId, signal, async (work) => {
      const index = work.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`#${id} not found`);
      const current = work.tasks[index];
      const updated = cloneTask(current);
      if (input.status !== undefined) {
        if (current.status === "deleted") throw new Error(`illegal transition deleted → ${input.status}`);
        if (current.status === "completed" && input.status !== "completed" && input.status !== "deleted") {
          throw new Error(`illegal transition completed → ${input.status}`);
        }
        updated.status = input.status;
      }
      if (input.subject !== undefined) updated.subject = input.subject;
      if (input.description !== undefined) updated.description = input.description;
      if (input.activeForm !== undefined) updated.activeForm = input.activeForm;
      if (input.owner !== undefined) updated.owner = input.owner;
      if (input.removeBlockedBy?.length) {
        const remove = new Set(input.removeBlockedBy);
        updated.blockedBy = (updated.blockedBy ?? []).filter((dep) => !remove.has(dep));
      }
      if (input.addBlockedBy?.length) {
        for (const dep of input.addBlockedBy) {
          if (dep === id) throw new Error(`cannot block #${id} on itself`);
          this.requireDependency(work.tasks, dep, "addBlockedBy");
          updated.blockedBy ??= [];
          if (!updated.blockedBy.includes(dep)) updated.blockedBy.push(dep);
        }
      }
      if (input.metadata !== undefined) {
        const merged = { ...(updated.metadata ?? {}) };
        for (const [key, value] of Object.entries(input.metadata)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        updated.metadata = Object.keys(merged).length ? merged : undefined;
      }
      const tasks = work.tasks.map((task, candidate) => (candidate === index ? updated : cloneTask(task)));
      const metadata: WorkMetadata = { ...work.metadata, tasks };
      if (input.status === "in_progress") metadata.activeTaskId = id;
      else if (metadata.activeTaskId === id && (input.status === "completed" || input.status === "pending" || input.status === "deleted")) {
        delete metadata.activeTaskId;
      }
      return metadata;
    });
  }

  async finishWork(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<FinishWorkResult> {
    const work = await this.getWork(scope, workId, signal);
    const unfinished = work.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
    if (unfinished.length) throw new Error(`工作任务仍有 ${unfinished.length} 个未完成步骤`);

    const data = await this.gateway.getProjectData(scope.binding.projectId, signal);
    let acceptanceTask = data.tasks.find(
      (task) => classifyAcceptanceTask(task) && task.status === 0 && task.content?.includes(`sourceWorkId: ${workId}`),
    );
    if (!acceptanceTask) {
      acceptanceTask = await this.gateway.createTask(
        buildAcceptanceTaskInput(work.remote, 2, buildAcceptanceSummary(work.remote.title, work.tasks)),
        signal,
      );
    }
    await this.gateway.completeTask(scope.binding.projectId, workId, signal);
    return { acceptanceTask };
  }

  private async mutate(
    scope: TodoScope,
    workId: string,
    signal: AbortSignal | undefined,
    reducer: (work: WorkTask) => Promise<WorkMetadata>,
  ): Promise<WorkTask> {
    return withFileMutationQueue(taskQueueKey(scope, workId), async () => {
      const work = await this.getWork(scope, workId, signal);
      let metadata = await reducer(work);
      const desired = metadataToItems(metadata);
      let remote = await this.gateway.updateTask(
        workId,
        this.buildUpdateInput(work.remote, metadata, work.userContent, desired),
        signal,
      );
      metadata = synchronizeItemIds(metadata, remote);
      remote = await this.gateway.updateTask(
        workId,
        this.buildUpdateInput(remote, metadata, work.userContent),
        signal,
      );
      const decoded = decodeWorkTask(remote);
      if (!decoded) throw new Error("更新后的滴答任务无法解析为 Pi Todo 工作任务");
      return decoded;
    });
  }

  private buildUpdateInput(
    remote: DidaTask,
    metadata: WorkMetadata,
    userContent: string,
    items = metadataToItems(metadata),
  ): Record<string, unknown> {
    return {
      id: remote.id,
      projectId: remote.projectId,
      title: remote.title,
      content: encodeManagedContent(userContent, metadata),
      items,
      tags: [...new Set([...(remote.tags ?? []), "pi-todo"])],
      priority: remote.priority ?? 0,
      ...(remote.desc !== undefined ? { desc: remote.desc } : {}),
      ...(remote.isAllDay !== undefined ? { isAllDay: remote.isAllDay } : {}),
      ...(remote.startDate !== undefined ? { startDate: remote.startDate } : {}),
      ...(remote.dueDate !== undefined ? { dueDate: remote.dueDate } : {}),
      ...(remote.timeZone !== undefined ? { timeZone: remote.timeZone } : {}),
      ...(remote.reminders !== undefined ? { reminders: remote.reminders } : {}),
      ...(remote.repeatFlag !== undefined ? { repeatFlag: remote.repeatFlag } : {}),
      ...(remote.sortOrder !== undefined ? { sortOrder: remote.sortOrder } : {}),
    };
  }

  private requireDependency(tasks: Task[], id: number, field: string): void {
    const dependency = tasks.find((task) => task.id === id);
    if (!dependency) throw new Error(`${field}: #${id} not found`);
    if (dependency.status === "deleted") throw new Error(`${field}: #${id} is deleted`);
  }
}
