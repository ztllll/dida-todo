import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Task, TodoScope, WorkTask } from "./domain.js";
import { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, pendingWorkFinalizations, updateSessionWork, updateSessionWorks } from "./runtime.js";
import { isExecutableWork } from "./work-queue.js";

export const PUBLIC_DIDA_TODO_COMMANDS = ["todos"] as const;

function taskLine(task: Task, glyph: string): string {
  return [
    `  ${glyph} #${task.id} ${task.subject}${task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : ""}`,
    ...(task.description ? [`      说明：${task.description}`] : []),
  ].join("\n");
}

function todosText(work: WorkTask): string {
  const visible = work.tasks.filter((task) => task.status !== "deleted");
  if (!visible.length) return "当前工作任务还没有执行步骤。";
  const mirroredTask = visible.find((task) => task.subject.trim() === work.remote.title.trim());
  const directTitleIsTask = mirroredTask !== undefined;
  const duplicateDescription = directTitleIsTask && mirroredTask?.description?.trim() === work.remote.desc?.trim();
  const pending = visible.filter((task) => task.status === "pending");
  const active = visible.filter((task) => task.status === "in_progress");
  const completed = visible.filter((task) => task.status === "completed" || task.status === "skipped");
  const lines = [
    ...(!directTitleIsTask ? [`${work.remote.title}`] : []),
    ...(work.remote.desc && !duplicateDescription ? [`描述：${work.remote.desc}`] : []),
    ...(work.userContent ? [`正文：\n${work.userContent}`] : []),
    `${completed.length}/${visible.length} completed · ${active.length} in progress · ${pending.length} pending`,
  ];
  if (pending.length) lines.push("── Pending ──", ...pending.map((task) => taskLine(task, "○")));
  if (active.length) lines.push("── In Progress ──", ...active.map((task) => taskLine(task, "◐")));
  if (completed.length) lines.push("── Completed ──", ...completed.map((task) => taskLine(task, "✓")));
  return lines.join("\n");
}

function runtimeFor(ctx: ExtensionCommandContext): { scope: TodoScope; work?: WorkTask } {
  const runtime = getSessionRuntime(ctx.sessionManager.getSessionId());
  if (!runtime) throw new Error("当前会话没有匹配的滴答项目绑定");
  return runtime;
}

export function registerCommands(
  pi: ExtensionAPI,
  repository: DidaTodoRepository,
  onWorkChanged: () => void,
  isInteractiveSession: (sessionId: string) => boolean,
): void {
  pi.registerCommand("todos", {
    description: "从滴答刷新并显示当前工作任务的全部执行步骤",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!ctx.hasUI || !isInteractiveSession(sessionId)) return;
      const runtime = runtimeFor(ctx);
      const result = await repository.syncOpenWorks(runtime.scope, {
        adoptUnmanaged: true,
        deferFinalizationWorkIds: pendingWorkFinalizations(sessionId),
      });
      updateSessionWorks(sessionId, result.works, runtime.work?.remote.id);
      let refreshed = getSessionRuntime(sessionId);
      const firstExecutable = result.works.find(isExecutableWork);
      if (!refreshed?.work && firstExecutable) {
        updateSessionWork(sessionId, firstExecutable);
        refreshed = getSessionRuntime(sessionId);
      }
      onWorkChanged();
      if (result.finalizationFailures.length) {
        ctx.ui.notify(
          [
            "以下工作已完成全部 Checklist，但自动创建验收 Todo 失败；源任务仍保持未完成：",
            ...result.finalizationFailures.map((failure) => `- ${failure.title}：${failure.error}`),
          ].join("\n"),
          "error",
        );
        return;
      }
      if (!refreshed?.work) {
        const stateText = result.works.length
          ? `滴答 Todo 已就绪：已同步 ${result.works.length} 个顶层任务，但当前没有满足优先级和时间条件的可执行工作。`
          : result.acceptances.length
            ? `滴答 Todo 已就绪：当前没有未完成工作；有 ${result.acceptances.length} 个待人类验收报告。可直接口述新任务。`
            : "滴答 Todo 已就绪：当前清单为空。可直接口述新任务，首个 Todo 会自动建立顶层工作并同步到滴答。";
        ctx.ui.notify(stateText, "info");
        return;
      }
      ctx.ui.notify(todosText(refreshed.work), "info");
    },
  });
}
