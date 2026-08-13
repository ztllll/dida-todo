import type { DidaTask, TodoScope, WorkTask } from "./domain.js";
import { ACCEPTANCE_COMMENT, acceptanceMatchesSource, buildAcceptanceSummary, buildAcceptanceTaskInput } from "./acceptance.js";
import { canFinalizeWork, migrateWorkMetadata } from "./work-lifecycle.js";
import { isWorkReadyForFinalization } from "./work-type.js";

export interface FinalizerGateway {
  getProjectData(projectId: string, signal?: AbortSignal): Promise<{ tasks: DidaTask[] }>;
  getTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<DidaTask>;
  updateTask(taskId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
  createTask(input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
  completeTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<void>;
  addTaskComment?(projectId: string, taskId: string, title: string, signal?: AbortSignal): Promise<void>;
  getTaskComments?(projectId: string, taskId: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string }>>;
}

function isLegacyPiWork(work: WorkTask): boolean {
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
      && visible.every((task) => task.status === "completed")
      && isWorkReadyForFinalization(work)
      && (canFinalizeWork(work) || isLegacyPiWork(work));
  }

  async finalize(scope: TodoScope, work: WorkTask, signal?: AbortSignal): Promise<DidaTask> {
    if (!this.gateway.addTaskComment || !this.gateway.getTaskComments) {
      throw new Error("Dida gateway 缺少验收评论能力，不能完成工作");
    }
    const data = await this.gateway.getProjectData(scope.binding.projectId, signal);
    if (work.remote.status !== 0) {
      const existing = data.tasks.find((task) => acceptanceMatchesSource(task, work.remote));
      if (existing) return existing;
      return this.createAcceptance(work, signal);
    }
    if (!canFinalizeWork(work) && !isLegacyPiWork(work)) {
      throw new Error("当前工作实例未被 Pi 接管，不能自动收口");
    }
    const visible = visibleTasks(work);
    if (!visible.length) throw new Error("工作任务没有可验收的 Checklist");
    const unfinished = visible.filter((task) => task.status === "pending" || task.status === "in_progress");
    if (unfinished.length) throw new Error(`工作任务仍有 ${unfinished.length} 个未完成步骤`);
    if (!isWorkReadyForFinalization(work)) throw new Error("Checklist 大任务尚未显式声明整体完成；完成 Item 只表示进度，不代表顶层工作结束");

    const acceptance = data.tasks.find((task) => acceptanceMatchesSource(task, work.remote))
      ?? await this.createAcceptance(work, signal);
    const comments = await this.gateway.getTaskComments(scope.binding.projectId, acceptance.id, signal);
    if (!comments.some((comment) => comment.title === ACCEPTANCE_COMMENT)) {
      await this.gateway.addTaskComment(scope.binding.projectId, acceptance.id, ACCEPTANCE_COMMENT, signal);
    }
    await this.completeRemoteItems(scope, work.remote.id, signal);
    await this.gateway.completeTask(scope.binding.projectId, work.remote.id, signal);
    return acceptance;
  }

  private async completeRemoteItems(scope: TodoScope, workId: string, signal?: AbortSignal): Promise<void> {
    const current = await this.gateway.getTask(scope.binding.projectId, workId, signal);
    if (!current.items?.length || current.items.every((item) => item.status === 1 || item.status === 2)) return;
    const items = current.items.map((item) => ({ ...structuredClone(item), status: 1 }));
    const updated = await this.gateway.updateTask(workId, {
      id: current.id,
      projectId: current.projectId,
      title: current.title,
      content: current.content ?? "",
      items,
      tags: current.tags ?? [],
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
    if ((updated.items ?? []).some((item) => item.status !== 1 && item.status !== 2)) {
      throw new Error("Checklist 子项未能全部标记完成，拒绝完成顶层任务");
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
