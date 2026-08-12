import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withHostLock } from "./host-lock.js";
import { decodeWorkTask, encodeManagedContent, metadataToItems, synchronizeItemIds } from "./codec.js";
import { claimCurrentOccurrence, claimDidaWork, createPiWorkMetadata, migrateWorkMetadata } from "./work-lifecycle.js";
import { WorkFinalizer } from "./work-finalizer.js";
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
import {
  ACCEPTANCE_REWORK_COMMENT_PREFIX,
  acceptanceReworkId,
  authorizedAcceptanceFeedback,
  buildAcceptanceTaskInput,
  classifyAcceptanceTask,
  type DidaComment,
} from "./acceptance.js";

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

export interface FinalizationFailure {
  workId: string;
  title: string;
  error: string;
}

export interface SyncOpenWorksResult {
  works: WorkTask[];
  adoptedWorkIds: string[];
  acceptances: PendingAcceptance[];
  finalizationFailures: FinalizationFailure[];
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
  return `work:${scope.binding.projectId}:${workId}`;
}

async function withWorkLock<T>(scope: TodoScope, workId: string, action: () => Promise<T>): Promise<T> {
  const key = taskQueueKey(scope, workId);
  return withFileMutationQueue(`/tmp/${key.replaceAll(":", "-")}.queue`, () => withHostLock(key, action));
}

export class DidaTodoRepository {
  private readonly finalizer: WorkFinalizer;

  constructor(private readonly gateway: DidaGateway) {
    this.finalizer = new WorkFinalizer(gateway);
  }

  async listOpenWorks(scope: TodoScope, signal?: AbortSignal): Promise<WorkTask[]> {
    return (await this.syncOpenWorks(scope, { adoptUnmanaged: false }, signal)).works;
  }

  async syncOpenWorks(
    scope: TodoScope,
    options: { adoptUnmanaged: boolean },
    signal?: AbortSignal,
  ): Promise<SyncOpenWorksResult> {
    const initial = await this.collectOpenWorks(scope, options, signal);
    const stranded = initial.works.filter((work) => this.finalizer.canAutoFinalize(work));
    if (!stranded.length) return initial;

    let finalized = false;
    const finalizationFailures: FinalizationFailure[] = [...initial.finalizationFailures];
    for (const work of stranded) {
      try {
        await this.finishWork(scope, work.remote.id, signal);
        finalized = true;
      } catch (error) {
        if (signal?.aborted) throw error;
        finalizationFailures.push({
          workId: work.remote.id,
          title: work.remote.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!finalized) return { ...initial, finalizationFailures };

    const refreshed = await this.collectOpenWorks(scope, options, signal);
    return {
      ...refreshed,
      adoptedWorkIds: [...new Set([...initial.adoptedWorkIds, ...refreshed.adoptedWorkIds])],
      finalizationFailures: [...finalizationFailures, ...refreshed.finalizationFailures],
    };
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
    try {
      await this.gateway.addTaskComment(scope.binding.projectId, workId, title, signal);
    } catch {
      // Progress comments are best-effort; Checklist state and acceptance finalization remain authoritative.
    }
  }

  async createReworkFromAcceptance(
    scope: TodoScope,
    acceptanceId: string,
    signal?: AbortSignal,
  ): Promise<WorkTask> {
    if (!this.gateway.addTaskComment || !this.gateway.getTaskComments) {
      throw new Error("Dida gateway 缺少验收评论能力，不能创建返工工作");
    }
    return withHostLock(`acceptance-rework:${scope.binding.projectId}:${acceptanceId}`, async () => {
      const acceptance = await this.gateway.getTask(scope.binding.projectId, acceptanceId, signal);
      if (!classifyAcceptanceTask(acceptance)) {
        throw new Error(`滴答任务 ${acceptanceId} 不是待验收任务`);
      }
      const comments = await this.gateway.getTaskComments!(scope.binding.projectId, acceptanceId, signal);
      const existingReworkId = acceptanceReworkId(comments);
      if (existingReworkId) {
        if (acceptance.status === 0) await this.gateway.completeTask(scope.binding.projectId, acceptanceId, signal);
        return this.getWork(scope, existingReworkId, signal);
      }
      if (acceptance.status !== 0) throw new Error(`待验收任务 ${acceptanceId} 已完成，不能创建返工工作`);
      const userComments = authorizedAcceptanceFeedback(comments);
      if (!userComments.length) throw new Error("待验收任务没有未处理的本人评论，不能创建返工工作");

      const sourceTitle = acceptance.title.replace(/^🧑‍🔬 待验收：/, "");
      const feedback = userComments.map((comment) => `- ${comment.title}`).join("\n");
      const metadata = createPiWorkMetadata(scope);
      const firstTask: Task = {
        id: 1,
        subject: `按验收反馈返工：${sourceTitle}`,
        description: feedback,
        status: "pending",
        metadata: { sourceAcceptanceId: acceptanceId },
      };
      const reworkMetadata: WorkMetadata = { ...metadata, nextId: 2, tasks: [firstTask] };
      let remote = await this.gateway.createTask({
        title: `返工：${sourceTitle}`,
        projectId: scope.binding.projectId,
        content: encodeManagedContent(`来源待验收：${acceptanceId}\n\n用户反馈：\n${feedback}`, reworkMetadata),
        items: metadataToItems(reworkMetadata),
        priority: acceptance.priority ?? 1,
        tags: ["pi-todo", "pi-todo-rework"],
      }, signal);
      const synced = synchronizeItemIds(reworkMetadata, remote);
      remote = await this.gateway.updateTask(
        remote.id,
        this.buildUpdateInput(remote, synced, `来源待验收：${acceptanceId}\n\n用户反馈：\n${feedback}`),
        signal,
      );
      await this.gateway.addTaskComment!(
        scope.binding.projectId,
        acceptanceId,
        `${ACCEPTANCE_REWORK_COMMENT_PREFIX}${remote.id}`,
        signal,
      );
      await this.gateway.completeTask(scope.binding.projectId, acceptanceId, signal);
      const work = decodeWorkTask(remote);
      if (!work) throw new Error("创建后的返工任务无法解析为 Pi Todo 工作任务");
      return work;
    });
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
    let metadata: WorkMetadata = claimDidaWork({
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "dida",
      lifecycle: "draft",
      nextId: tasks.length + 1,
      tasks,
      sessionIds: [scope.sessionId],
      ...(scope.tmuxTarget ? { tmuxTarget: scope.tmuxTarget } : {}),
      cwd: scope.cwd,
    }, remote, scope);
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
    const normalizedTitle = title.trim();
    return withHostLock(`bootstrap:${scope.binding.projectId}:${scope.sessionId}`, async () => {
      const existing = await this.collectOpenWorks(scope, { adoptUnmanaged: false }, signal);
      const currentWork = existing.works.find((work) => {
        const metadata = migrateWorkMetadata(work.metadata);
        return metadata.origin === "pi"
          && metadata.execution?.owner?.sessionId === scope.sessionId
          && work.remote.title === normalizedTitle;
      });
      if (currentWork) return currentWork;
      const metadata: WorkMetadata = createPiWorkMetadata(scope);
    let remote = await this.gateway.createTask(
      {
        title: normalizedTitle,
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
    });
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
      const claimed = input.status === "in_progress"
        ? claimCurrentOccurrence(work.metadata, work.remote, scope)
        : work.metadata;
      const index = work.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`#${id} not found`);
      const current = work.tasks[index];
      if (current.metadata?.source === "dida") {
        const changesUserContent = input.subject !== undefined
          || input.description !== undefined
          || input.activeForm !== undefined
          || input.owner !== undefined
          || input.addBlockedBy !== undefined
          || input.removeBlockedBy !== undefined
          || (input.metadata !== undefined && Object.keys(input.metadata).some((key) => key !== "resolution"));
        if (changesUserContent) throw new Error("用户创建的 Checklist 步骤不允许修改内容；请使用 todo create 追加新步骤");
        if (input.status === "deleted") throw new Error("用户创建的 Checklist 步骤不允许删除；请保留原步骤并追加新步骤");
      }
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
      const metadata: WorkMetadata = { ...claimed, tasks };
      if (input.status === "in_progress") metadata.activeTaskId = id;
      else if (metadata.activeTaskId === id && (input.status === "completed" || input.status === "pending" || input.status === "deleted")) {
        delete metadata.activeTaskId;
      }
      return metadata;
    }, input.status === "completed" ? id : undefined);
  }

  async finishWork(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<FinishWorkResult> {
    return withWorkLock(scope, workId, async () => {
      const work = await this.getWork(scope, workId, signal);
      return this.finishWorkLocked(scope, work, signal);
    });
  }

  private async collectOpenWorks(
    scope: TodoScope,
    options: { adoptUnmanaged: boolean },
    signal?: AbortSignal,
  ): Promise<SyncOpenWorksResult> {
    const data = await this.gateway.getProjectData(scope.binding.projectId, signal);
    const works: WorkTask[] = [];
    const adoptedWorkIds: string[] = [];
    const acceptances: PendingAcceptance[] = [];
    const finalizationFailures: FinalizationFailure[] = [];
    for (const remote of data.tasks) {
      if (remote.tags?.includes("pi-todo-reminder")) continue;
      if (classifyAcceptanceTask(remote)) {
        const comments = this.gateway.getTaskComments
          ? await this.gateway.getTaskComments(scope.binding.projectId, remote.id, signal)
          : [];
        if (authorizedAcceptanceFeedback(comments).length) {
          try {
            works.push(await this.createReworkFromAcceptance(scope, remote.id, signal));
          } catch (error) {
            if (signal?.aborted) throw error;
            acceptances.push({ remote, comments });
            finalizationFailures.push({
              workId: remote.id,
              title: remote.title,
              error: `创建验收返工失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        } else {
          acceptances.push({ remote, comments });
        }
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
    return { works, adoptedWorkIds, acceptances, finalizationFailures };
  }

  private async finishWorkLocked(scope: TodoScope, work: WorkTask, signal?: AbortSignal): Promise<FinishWorkResult> {
    return { acceptanceTask: await this.finalizer.finalize(scope, work, signal) };
  }

  private async mutate(
    scope: TodoScope,
    workId: string,
    signal: AbortSignal | undefined,
    reducer: (work: WorkTask) => Promise<WorkMetadata>,
    completedTaskId?: number,
  ): Promise<WorkTask> {
    return withWorkLock(scope, workId, async () => {
      const work = await this.getWork(scope, workId, signal);
      if (work.remote.status !== 0) throw new Error("已完成的工作任务不能修改 Checklist");
      let metadata = await reducer(work);
      metadata = migrateWorkMetadata(metadata);
      const desired = metadataToItems(metadata, work.remote.items ?? []);
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
      if (completedTaskId !== undefined) {
        if (this.finalizer.canAutoFinalize(decoded)) {
          await this.finishWorkLocked(scope, decoded, signal);
          decoded.remote.status = 2;
        }
      }
      return decoded;
    });
  }

  private buildUpdateInput(
    remote: DidaTask,
    metadata: WorkMetadata,
    userContent: string,
    items = metadataToItems(metadata, remote.items ?? []),
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
