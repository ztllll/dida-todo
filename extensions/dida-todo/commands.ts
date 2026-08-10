import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Task, TodoScope, WorkTask } from "./domain.js";
import { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, updateSessionWork, updateSessionWorks } from "./runtime.js";
import { isExecutableWork } from "./work-queue.js";

export const PUBLIC_DIDA_TODO_COMMANDS = ["todos"] as const;

function taskLine(task: Task, glyph: string): string {
  return `  ${glyph} #${task.id} ${task.subject}${task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : ""}`;
}

function todosText(work: WorkTask): string {
  const visible = work.tasks.filter((task) => task.status !== "deleted");
  if (!visible.length) return "当前工作任务还没有执行步骤。";
  const pending = visible.filter((task) => task.status === "pending");
  const active = visible.filter((task) => task.status === "in_progress");
  const completed = visible.filter((task) => task.status === "completed");
  const lines = [
    `${work.remote.title}`,
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

export function registerCommands(pi: ExtensionAPI, repository: DidaTodoRepository, onWorkChanged: () => void): void {
  pi.registerCommand("todos", {
    description: "从滴答刷新并显示当前工作任务的全部执行步骤",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const runtime = runtimeFor(ctx);
      const result = await repository.syncOpenWorks(runtime.scope, { adoptUnmanaged: true });
      updateSessionWorks(sessionId, result.works, runtime.work?.remote.id);
      let refreshed = getSessionRuntime(sessionId);
      const firstExecutable = result.works.find(isExecutableWork);
      if (!refreshed?.work && firstExecutable) {
        updateSessionWork(sessionId, firstExecutable);
        refreshed = getSessionRuntime(sessionId);
      }
      onWorkChanged();
      if (!refreshed?.work) {
        const acceptanceText = result.acceptances.length ? `当前没有未完成工作任务；有 ${result.acceptances.length} 个待人类验收报告。` : "当前没有未完成工作任务。";
        ctx.ui.notify(acceptanceText, "info");
        return;
      }
      ctx.ui.notify(todosText(refreshed.work), "info");
    },
  });
}
