import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withHostLock } from "./host-lock.js";
import { decodeMetadata, decodeWorkTask, metadataToItems, stripManagedContent, synchronizeItemIds } from "./codec.js";
import { claimCurrentOccurrence, claimDidaWork, createPiWorkMetadata, migrateWorkMetadata, readyForAcceptance } from "./work-lifecycle.js";
import { WorkFinalizer } from "./work-finalizer.js";
import type {
  DidaProjectData,
  DidaTask,
  Task,
  TaskStatus,
  TodoScope,
  WorkMetadata,
  WorkTask,
  DidaWorkType,
} from "./domain.js";
import { buildCompletionReminderInput } from "./scheduling.js";
import { buildAcceptanceResultUpdate, buildHumanAcceptanceResult } from "./acceptance-result.js";
import { MemoryWorkStateStore, type WorkStateStore } from "./state-store.js";
import { composeHumanWorkDescription, originalHumanDescription } from "./human-task-surface.js";
import {
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
  keepWorkOpen?: boolean;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
}

function humanVisibleText(value: string): string {
  return value
    .replace(/<!-- pi-dida-todo:start -->[\s\S]*?<!-- pi-dida-todo:end -->/g, "")
    .replace(/\b(?:bindingKey|sessionId|workId|itemId|sourceWorkId|sourceOccurrence|lifecycle)\s*[:=]\s*\S+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

  constructor(
    private readonly gateway: DidaGateway,
    private readonly stateStore: WorkStateStore = new MemoryWorkStateStore(),
  ) {
    this.finalizer = new WorkFinalizer(gateway);
  }

  async listOpenWorks(scope: TodoScope, signal?: AbortSignal): Promise<WorkTask[]> {
    return (await this.syncOpenWorks(scope, { adoptUnmanaged: false }, signal)).works;
  }

  async syncOpenWorks(
    scope: TodoScope,
    options: { adoptUnmanaged: boolean; deferFinalizationWorkIds?: string[] },
    signal?: AbortSignal,
  ): Promise<SyncOpenWorksResult> {
    const initial = await this.collectOpenWorks(scope, options, signal);
    const deferred = new Set(options.deferFinalizationWorkIds ?? []);
    const stranded = initial.works.filter((work) => !deferred.has(work.remote.id) && this.finalizer.canAutoFinalize(work));
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
    const stored = await this.stateStore.get(scope.binding.projectId, workId);
    const work = decodeWorkTask(remote, stored);
    if (!work) throw new Error(`滴答任务 ${workId} 不是 Pi Todo 工作任务`);
    if (work.metadata.bindingKey !== scope.bindingKey) throw new Error(`滴答任务 ${workId} 不属于当前项目绑定`);
    return work;
  }

  async adoptWork(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<WorkTask> {
    const remote = await this.gateway.getTask(scope.binding.projectId, workId, signal);
    if (remote.status !== 0) throw new Error(`只能接管未完成的滴答任务: ${workId}`);
    const stored = await this.stateStore.get(scope.binding.projectId, workId);
    if (decodeWorkTask(remote, stored)) return this.getWork(scope, workId, signal);
    return this.adoptRemoteTask(scope, remote, signal);
  }

  async addProgressComment(scope: TodoScope, workId: string, title: string, signal?: AbortSignal): Promise<void> {
    if (!this.gateway.addTaskComment) return;
    try {
      await this.gateway.addTaskComment(scope.binding.projectId, workId, humanVisibleText(title), signal);
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
      const storedAcceptance = await this.stateStore.getAcceptance(scope.binding.projectId, acceptanceId);
      const existingReworkId = storedAcceptance?.reworkWorkId ?? acceptanceReworkId(comments);
      if (existingReworkId) {
        if (acceptance.status === 0) await this.gateway.completeTask(scope.binding.projectId, acceptanceId, signal);
        return this.getWork(scope, existingReworkId, signal);
      }
      if (acceptance.status !== 0) throw new Error(`待验收任务 ${acceptanceId} 已完成，不能创建返工工作`);
      const userComments = authorizedAcceptanceFeedback(comments);
      if (!userComments.length) throw new Error("待验收任务没有未处理的本人评论，不能创建返工工作");

      if (!storedAcceptance) throw new Error("本机状态库缺少验收来源关联，不能安全创建返工");
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
      const userContent = `用户反馈：\n${feedback}`;
      const reworkMetadata: WorkMetadata = { ...metadata, userContent, nextId: 2, tasks: [firstTask] };
      let remote = await this.gateway.createTask({
        title: `返工：${sourceTitle}`,
        projectId: scope.binding.projectId,
        content: userContent,
        items: metadataToItems(reworkMetadata),
        priority: acceptance.priority ?? 1,
        tags: ["pi-todo", "pi-todo-rework"],
      }, signal);
      const synced = synchronizeItemIds(reworkMetadata, remote);
      await this.stateStore.set(remote.projectId, remote.id, synced);
      remote = await this.gateway.updateTask(
        remote.id,
        this.buildUpdateInput(remote, synced, userContent),
        signal,
      );
      const finalMetadata = synchronizeItemIds(synced, remote);
      await this.stateStore.set(remote.projectId, remote.id, finalMetadata);
      await this.stateStore.setRework(scope.binding.projectId, acceptanceId, remote.id);
      await this.gateway.addTaskComment!(
        scope.binding.projectId,
        acceptanceId,
        "🤖 已根据你的反馈创建返工任务。",
        signal,
      );
      await this.gateway.completeTask(scope.binding.projectId, acceptanceId, signal);
      const work = decodeWorkTask(remote, finalMetadata);
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
    const userContent = stripManagedContent(remote.content);
    if (remote.desc?.trim()) metadata = { ...metadata, userDescription: stripManagedContent(remote.desc) };
    metadata = { ...metadata, userContent };
    metadata = synchronizeItemIds(metadata, remote);
    await this.stateStore.set(remote.projectId, remote.id, metadata);
    const updated = await this.gateway.updateTask(
      remote.id,
      this.buildUpdateInput(remote, metadata, userContent),
      signal,
    );
    metadata = synchronizeItemIds(metadata, updated);
    await this.stateStore.set(updated.projectId, updated.id, metadata);
    const work = decodeWorkTask(updated, metadata);
    if (!work) throw new Error(`无法接管滴答工作任务: ${remote.id}`);
    return work;
  }

  async createWork(
    scope: TodoScope,
    title: string,
    signal?: AbortSignal,
    workType: DidaWorkType = "checklist",
    content?: string,
    description?: string,
    priority: 1 | 3 | 5 = 1,
  ): Promise<WorkTask> {
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
      const metadata = createPiWorkMetadata(scope, workType);
      const userContent = content?.trim() ?? "";
      const userDescription = description?.trim() ?? "";
      const metadataWithContent: WorkMetadata = {
        ...metadata,
        userContent,
        ...(userDescription ? { userDescription } : {}),
      };
      let remote = await this.gateway.createTask(
        {
          title: normalizedTitle,
          projectId: scope.binding.projectId,
          content: userContent,
          ...(workType === "checklist" ? { items: [] } : {}),
          ...(userDescription ? { desc: userDescription } : {}),
          priority,
          tags: ["pi-todo"],
        },
        signal,
      );
      const synced = synchronizeItemIds(metadataWithContent, remote);
      await this.stateStore.set(remote.projectId, remote.id, synced);
      remote = await this.gateway.updateTask(
        remote.id,
        this.buildUpdateInput(remote, synced, userContent),
        signal,
      );
      const finalMetadata = synchronizeItemIds(synced, remote);
      await this.stateStore.set(remote.projectId, remote.id, finalMetadata);
      return decodeWorkTask(remote, finalMetadata) ?? { remote, metadata: finalMetadata, tasks: finalMetadata.tasks, userContent };
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
      const metadata = migrateWorkMetadata(work.metadata);
      const promoteDidaDirectToChecklist = metadata.origin === "dida" && metadata.workType === "direct";
      return {
        ...metadata,
        ...(promoteDidaDirectToChecklist ? { workType: "checklist" as const } : {}),
        lifecycle: metadata.lifecycle === "ready_for_acceptance" ? "claimed" : metadata.lifecycle,
        finalization: metadata.lifecycle === "ready_for_acceptance" ? undefined : metadata.finalization,
        nextId: metadata.nextId + 1,
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
    options: { deferFinalization?: boolean } = {},
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
        if ((current.status === "completed" || current.status === "skipped") && input.status !== current.status && input.status !== "deleted") {
          throw new Error(`illegal transition ${current.status} → ${input.status}`);
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
      let metadata = migrateWorkMetadata({ ...claimed, tasks });
      if (input.keepWorkOpen === true) metadata = { ...metadata, keepOpen: true };
      else if (input.keepWorkOpen === false) {
        const { keepOpen: _keepOpen, ...withoutKeepOpen } = metadata;
        metadata = withoutKeepOpen;
      }
      if (input.status === "in_progress") metadata.activeTaskId = id;
      else if (metadata.activeTaskId === id && (input.status === "completed" || input.status === "skipped" || input.status === "pending" || input.status === "deleted")) {
        delete metadata.activeTaskId;
      }
      return metadata;
    }, (input.status === "completed" || input.status === "skipped") && !options.deferFinalization ? id : undefined);
  }

  async markWorkReadyForAcceptance(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<WorkTask> {
    return this.mutate(scope, workId, signal, async (work) => {
      const visible = work.tasks.filter((task) => task.status !== "deleted");
      const unfinished = visible.filter((task) => task.status === "pending" || task.status === "in_progress");
      if (!visible.length) throw new Error("工作任务没有可验收的执行步骤");
      if (unfinished.length) throw new Error(`工作任务仍有 ${unfinished.length} 个未完成步骤，不能声明整体完成`);
      return readyForAcceptance(work.metadata);
    });
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
    for (let remote of data.tasks) {
      if (remote.tags?.includes("pi-todo-reminder")) continue;
      if (classifyAcceptanceTask(remote)) {
        const legacyAcceptanceLink = this.legacyAcceptanceLink(remote);
        if (legacyAcceptanceLink && !(await this.stateStore.getAcceptance(scope.binding.projectId, remote.id))) {
          await this.stateStore.setAcceptance(scope.binding.projectId, remote.id, legacyAcceptanceLink);
        }
        const comments = this.gateway.getTaskComments
          ? await this.gateway.getTaskComments(scope.binding.projectId, remote.id, signal)
          : [];
        const storedAcceptance = await this.stateStore.getAcceptance(scope.binding.projectId, remote.id);
        const sourceId = storedAcceptance?.sourceWorkId ?? legacyAcceptanceLink?.sourceWorkId;
        if (sourceId && this.legacyAcceptanceLink(remote)) {
          const sourceMetadata = await this.stateStore.get(scope.binding.projectId, sourceId);
          const source = data.tasks.find((task) => task.id === sourceId)
            ?? { id: sourceId, projectId: scope.binding.projectId, title: remote.title.replace(/^🧑‍🔬 待验收：/, ""), status: 2, priority: remote.priority };
          const sourceForReport = { ...source, title: remote.title.replace(/^🧑‍🔬 待验收：/, "") };
          const report = buildHumanAcceptanceResult(sourceForReport, sourceMetadata, remote.desc ?? "");
          remote = await this.gateway.updateTask(remote.id, buildAcceptanceResultUpdate(sourceForReport, remote, report, { deriveTitle: false }), signal);
        }
        if (authorizedAcceptanceFeedback(comments).length) {
          if (!storedAcceptance) {
            acceptances.push({ remote, comments });
            finalizationFailures.push({
              workId: remote.id,
              title: remote.title,
              error: "创建验收返工失败：本机状态库缺少验收来源关联；请先在创建该验收的宿主恢复状态",
            });
            continue;
          }
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
      const stored = await this.stateStore.get(scope.binding.projectId, remote.id);
      let work = decodeWorkTask(remote, stored);
      if (work) {
        if (work.metadata.bindingKey === scope.bindingKey) {
          const metadata = migrateWorkMetadata(work.metadata);
          if (!stored) {
            await this.stateStore.set(scope.binding.projectId, remote.id, metadata);
            work = await this.cleanLegacyManagedFields(remote, metadata, signal);
          } else if (JSON.stringify(metadata) !== JSON.stringify(migrateWorkMetadata(stored))) {
            await this.stateStore.set(scope.binding.projectId, remote.id, metadata);
          }
          if (metadata.origin === "pi" && (remote.priority ?? 0) <= 0) {
            work = await this.migratePiWorkPriority(scope, remote.id, signal);
          }
          works.push(work);
        }
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
    const sourceOccurrence = work.metadata.schemaVersion === 2 ? work.metadata.execution?.occurrence : undefined;
    const existingAcceptanceId = await this.stateStore.findAcceptance(
      scope.binding.projectId,
      work.remote.id,
      sourceOccurrence,
    );
    try {
      const acceptanceTask = await this.finalizer.finalize(scope, work, signal, existingAcceptanceId);
      await this.stateStore.setAcceptance(scope.binding.projectId, acceptanceTask.id, {
        sourceWorkId: work.remote.id,
        ...(sourceOccurrence ? { sourceOccurrence } : {}),
      });
      return { acceptanceTask };
    } catch (error) {
      const data = await this.gateway.getProjectData(scope.binding.projectId, signal).catch(() => undefined);
      const candidate = data?.tasks.find((task) => task.status === 0 && classifyAcceptanceTask(task) && task.title === `🧑‍🔬 待验收：${work.remote.title}`);
      if (candidate) {
        await this.stateStore.setAcceptance(scope.binding.projectId, candidate.id, {
          sourceWorkId: work.remote.id,
          ...(sourceOccurrence ? { sourceOccurrence } : {}),
        });
      }
      throw error;
    }
  }

  private legacyAcceptanceLink(remote: DidaTask): { sourceWorkId: string; sourceOccurrence?: string } | undefined {
    const sourceWorkId = remote.content?.split("\n").find((line) => line.startsWith("sourceWorkId: "))?.slice("sourceWorkId: ".length);
    if (!sourceWorkId) return undefined;
    const sourceOccurrence = remote.content?.split("\n").find((line) => line.startsWith("sourceOccurrence: "))?.slice("sourceOccurrence: ".length);
    return { sourceWorkId, ...(sourceOccurrence ? { sourceOccurrence } : {}) };
  }

  private async cleanLegacyManagedFields(
    remote: DidaTask,
    metadata: WorkMetadata,
    signal?: AbortSignal,
  ): Promise<WorkTask> {
    const migrated = migrateWorkMetadata(metadata);
    const legacyInContent = decodeMetadata(remote.content) !== undefined;
    const legacyInDescription = decodeMetadata(remote.desc) !== undefined;
    const userContent = migrated.userContent ?? (legacyInDescription
      ? stripManagedContent(remote.desc)
      : stripManagedContent(remote.content));
    const userDescription = migrated.userDescription ?? (legacyInDescription ? undefined : stripManagedContent(remote.desc));
    const cleanMetadata: WorkMetadata = {
      ...migrated,
      userContent,
      ...(userDescription ? { userDescription } : {}),
    };
    await this.stateStore.set(remote.projectId, remote.id, cleanMetadata);
    const cleaned = await this.gateway.updateTask(
      remote.id,
      this.buildUpdateInput(remote, cleanMetadata, userContent),
      signal,
    );
    const decoded = decodeWorkTask(cleaned, cleanMetadata);
    if (!decoded) throw new Error(`迁移受管状态后无法解析任务: ${remote.id}`);
    return decoded;
  }

  private async migratePiWorkPriority(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<WorkTask> {
    return withWorkLock(scope, workId, async () => {
      const currentRemote = await this.gateway.getTask(scope.binding.projectId, workId, signal);
      const stored = await this.stateStore.get(scope.binding.projectId, workId);
      const current = decodeWorkTask(currentRemote, stored);
      if (!current) throw new Error(`迁移优先级时滴答任务无法解析为 Pi 工作: ${workId}`);
      if (current.metadata.bindingKey !== scope.bindingKey) throw new Error(`滴答任务 ${workId} 不属于当前项目绑定`);
      const metadata = migrateWorkMetadata(current.metadata);
      if (metadata.origin !== "pi" || (currentRemote.priority ?? 0) > 0) return current;
      const migrated = await this.gateway.updateTask(
        workId,
        this.buildUpdateInput({ ...currentRemote, priority: 1 }, current.metadata, current.userContent),
        signal,
      );
      const decoded = decodeWorkTask(migrated, current.metadata);
      if (!decoded) throw new Error(`迁移 Pi 工作优先级后无法解析任务: ${workId}`);
      if ((decoded.remote.priority ?? 0) !== 1) throw new Error(`Pi 工作优先级迁移失败: ${workId}`);
      return decoded;
    });
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
      if (metadata.origin === "dida" && metadata.workType === "direct" && metadata.tasks.some((task) => task.status !== "deleted")) {
        metadata = { ...metadata, workType: "checklist" };
      }
      const userDescription = originalHumanDescription(metadata, work.userContent, work.remote.desc);
      metadata = {
        ...metadata,
        userContent: work.userContent,
        ...(userDescription ? { userDescription } : {}),
      };
      const desired = metadataToItems(metadata, work.remote.items ?? []);
      let remote = await this.gateway.updateTask(
        workId,
        this.buildUpdateInput(work.remote, metadata, work.userContent, desired),
        signal,
      );
      metadata = synchronizeItemIds(metadata, remote);
      await this.stateStore.set(scope.binding.projectId, workId, metadata);
      remote = await this.gateway.updateTask(
        workId,
        this.buildUpdateInput(remote, metadata, work.userContent),
        signal,
      );
      metadata = synchronizeItemIds(metadata, remote);
      await this.stateStore.set(scope.binding.projectId, workId, metadata);
      const decoded = decodeWorkTask(remote, metadata);
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
    const migrated = migrateWorkMetadata(metadata);
    const checklist = migrated.workType === "checklist";
    const humanDescription = checklist
      ? composeHumanWorkDescription(metadata, userContent, remote.desc)
      : migrated.userDescription ?? stripManagedContent(remote.desc);
    return {
      id: remote.id,
      projectId: remote.projectId,
      title: remote.title,
      content: checklist ? "" : userContent,
      ...(checklist ? { items } : {}),
      tags: [...new Set([...(remote.tags ?? []), "pi-todo"])],
      priority: remote.priority ?? 0,
      ...(humanDescription ? { desc: humanDescription } : remote.desc !== undefined ? { desc: "" } : {}),
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
