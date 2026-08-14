import type { DidaTask, TodoScope, WorkTask } from "./domain.js";
import { ACCEPTANCE_COMMENT, acceptanceMatchesSource, buildAcceptanceSummary, buildAcceptanceTaskInput } from "./acceptance.js";
import { canFinalizeWork, migrateWorkMetadata } from "./work-lifecycle.js";
import { isWorkReadyForFinalization } from "./work-type.js";
import { managedWorkTags } from "./tags.js";

export interface FinalizerGateway {
  getProjectData(projectId: string, signal?: AbortSignal): Promise<{ tasks: DidaTask[] }>;
  getTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<DidaTask>;
  updateTask(taskId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
  createTask(input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
  completeTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<void>;
  addTaskComment?(projectId: string, taskId: string, title: string, signal?: AbortSignal): Promise<void>;
  getTaskComments?(projectId: string, taskId: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string }>>;
}

function isLegacyMigratedWork(work: WorkTask): boolean {
  return migrateWorkMetadata(work.metadata).migratedFromVersion === 1 && !work.remote.repeatFlag;
}

function visibleTasks(work: WorkTask) {
  return work.tasks.filter((task) => task.status !== "deleted");
}

export class WorkFinalizer {
  constructor(private readonly gateway: FinalizerGateway) {}

  canAutoFinalize(work: WorkTask): boolean {
    const visible = visibleTasks(work);
    return work.remote.status === 0
      && visible.length > 0
      && visible.every((task) => task.status === "completed" || task.status === "skipped")
      && isWorkReadyForFinalization(work)
      && (canFinalizeWork(work) || isLegacyMigratedWork(work));
  }

  async finalize(scope: TodoScope, work: WorkTask, signal?: AbortSignal, existingAcceptanceId?: string): Promise<DidaTask> {
    if (!this.gateway.addTaskComment || !this.gateway.getTaskComments) {
      throw new Error("Dida gateway 缺少验收评论能力，不能完成工作");
    }
    const data = await this.gateway.getProjectData(scope.binding.projectId, signal);
    const storedAcceptance = existingAcceptanceId
      ? data.tasks.find((task) => task.id === existingAcceptanceId && task.status === 0)
        ?? await this.gateway.getTask(scope.binding.projectId, existingAcceptanceId, signal).catch(() => undefined)
      : undefined;
    if (work.remote.status !== 0) {
      const existing = storedAcceptance ?? data.tasks.find((task) => acceptanceMatchesSource(task, work.remote));
      if (existing) return existing;
      return this.createAcceptance(work, signal);
    }
    if (!canFinalizeWork(work) && !isLegacyMigratedWork(work)) {
      throw new Error("当前工作实例未被 Agent 接管，不能自动收口");
    }
    const visible = visibleTasks(work);
    if (!visible.length) throw new Error("工作任务没有可验收的 Checklist");
    const unfinished = visible.filter((task) => task.status === "pending" || task.status === "in_progress");
    if (unfinished.length) throw new Error(`工作任务仍有 ${unfinished.length} 个未完成步骤`);
    if (!isWorkReadyForFinalization(work)) throw new Error("Checklist 大任务尚未显式声明整体完成；完成 Item 只表示进度，不代表顶层工作结束");

    const acceptance = storedAcceptance
      ?? data.tasks.find((task) => acceptanceMatchesSource(task, work.remote))
      ?? await this.createAcceptance(work, signal);
    const comments = await this.gateway.getTaskComments(scope.binding.projectId, acceptance.id, signal);
    if (!comments.some((comment) => comment.title === ACCEPTANCE_COMMENT)) {
      await this.gateway.addTaskComment(scope.binding.projectId, acceptance.id, ACCEPTANCE_COMMENT, signal);
    }
    await this.completeRemoteItems(scope, work, signal);
    await this.gateway.completeTask(scope.binding.projectId, work.remote.id, signal);
    return acceptance;
  }

  private async completeRemoteItems(scope: TodoScope, source: WorkTask, signal?: AbortSignal): Promise<void> {
    const current = await this.gateway.getTask(scope.binding.projectId, source.remote.id, signal);
    if (!current.items?.length) return;
    const taskByItemId = new Map(source.tasks.filter((task) => task.itemId).map((task) => [task.itemId as string, task]));
    const items = current.items.map((item) => {
      const task = item.id ? taskByItemId.get(item.id) : source.tasks.find((candidate) => candidate.subject === item.title);
      return {
        ...structuredClone(item),
        status: task?.status === "completed" ? 1 : item.status ?? 0,
      };
    });
    const updated = await this.gateway.updateTask(source.remote.id, {
      id: current.id,
      projectId: current.projectId,
      title: current.title,
      content: current.content ?? "",
      items,
      tags: managedWorkTags(current.tags),
      priority: current.priority ?? 0,
      ...(current.desc !== undefined ? { desc: current.desc } : {}),
      ...(current.isAllDay !== undefined ? { isAllDay: current.isAllDay } : {}),
      ...(current.startDate !== undefined ? { startDate: current.startDate } : {}),
      ...(current.dueDate !== undefined ? { dueDate: current.dueDate } : {}),
      ...(current.timeZone !== undefined ? { timeZone: current.timeZone } : {}),
      ...(current.reminders !== undefined ? { reminders: current.reminders } : {}),
      ...(current.repeatFlag !== undefined ? { repeatFlag: current.repeatFlag } : {}),
      ...(current.sortOrder !== undefined ? { sortOrder: current.sortOrder } : {}),
    }, signal);
    if ((updated.items ?? []).length !== items.length) {
      throw new Error("Checklist 子项数量发生变化，拒绝完成顶层任务");
    }
  }

  private async createAcceptance(work: WorkTask, signal?: AbortSignal): Promise<DidaTask> {
    const visible = visibleTasks(work);
    return this.gateway.createTask(
      buildAcceptanceTaskInput(
        work.remote,
        3,
        buildAcceptanceSummary(work.remote.title, visible, {
          ...(work.remote.desc ? { description: work.remote.desc } : {}),
          ...(work.userContent ? { content: work.userContent } : {}),
        }),
      ),
      signal,
    );
  }
}
