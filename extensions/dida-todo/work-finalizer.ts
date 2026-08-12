import type { DidaTask, TodoScope, WorkTask } from "./domain.js";
import { ACCEPTANCE_COMMENT, acceptanceMatchesSource, buildAcceptanceSummary, buildAcceptanceTaskInput } from "./acceptance.js";
import { canFinalizeWork, migrateWorkMetadata } from "./work-lifecycle.js";

export interface FinalizerGateway {
  getProjectData(projectId: string, signal?: AbortSignal): Promise<{ tasks: DidaTask[] }>;
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

    const acceptance = data.tasks.find((task) => acceptanceMatchesSource(task, work.remote))
      ?? await this.createAcceptance(work, signal);
    const comments = await this.gateway.getTaskComments(scope.binding.projectId, acceptance.id, signal);
    if (!comments.some((comment) => comment.title === ACCEPTANCE_COMMENT)) {
      await this.gateway.addTaskComment(scope.binding.projectId, acceptance.id, ACCEPTANCE_COMMENT, signal);
    }
    await this.gateway.completeTask(scope.binding.projectId, work.remote.id, signal);
    return acceptance;
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
