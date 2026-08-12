import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, updateSessionWork, updateSessionWorks } from "./runtime.js";
import { isExecutableWork, rankExecutableWorks } from "./work-queue.js";
import { unacknowledgedAcceptanceFeedback } from "./acceptance.js";

export interface PollState {
  idle: boolean;
  hasPendingMessages: boolean;
  boundWorkId?: string;
  remoteWorkIds: string[];
  pendingAcceptanceIds?: string[];
  newAcceptanceFeedbackKeys?: string[];
}

export function pollDecision(state: PollState): "silent" | "trigger" {
  if (!state.idle || state.hasPendingMessages) return "silent";
  return state.remoteWorkIds.length > 0 || (state.newAcceptanceFeedbackKeys?.length ?? 0) > 0 ? "trigger" : "silent";
}

export function selectPolledWork(works: WorkTask[], now = new Date()): WorkTask | undefined {
  return rankExecutableWorks(works, now)[0];
}

export function startTodoPoller(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repository: DidaTodoRepository,
  intervalMinutes: number,
  onWorkChanged: () => void,
): () => void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error("pollIntervalMinutes 必须是 1 到 1440 的整数");
  }
  const sessionId = ctx.sessionManager.getSessionId();
  let running = false;
  let stopped = false;

  const poll = async () => {
    if (running || stopped) return;
    const runtime = getSessionRuntime(sessionId);
    if (!runtime) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    running = true;
    try {
      const sync = await repository.syncOpenWorks(runtime.scope, { adoptUnmanaged: true });
      const executableWorks = sync.works.filter(isExecutableWork);
      const finalizationFailureIds = sync.finalizationFailures.map((failure) => failure.workId);
      const unacknowledgedFeedback = sync.acceptances.flatMap(({ remote, comments }) =>
        unacknowledgedAcceptanceFeedback(comments).map((comment) => ({ acceptanceId: remote.id, comment })),
      );
      const newAcceptanceFeedbackKeys = unacknowledgedFeedback.map(
        ({ acceptanceId, comment }) => `${acceptanceId}:${comment.id}`,
      );
      if (pollDecision({
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        boundWorkId: getSessionRuntime(sessionId)?.work?.remote.id,
        remoteWorkIds: [...executableWorks.map((work) => work.remote.id), ...finalizationFailureIds],
        pendingAcceptanceIds: sync.acceptances.map(({ remote }) => remote.id),
        newAcceptanceFeedbackKeys,
      }) !== "trigger") {
        updateSessionWorks(sessionId, sync.works, runtime.work?.remote.id);
        onWorkChanged();
        return;
      }
      const selected = selectPolledWork(executableWorks);
      updateSessionWorks(sessionId, sync.works, selected?.remote.id);
      if (selected) updateSessionWork(sessionId, selected);
      onWorkChanged();
      pi.sendUserMessage(
        finalizationFailureIds.length
          ? "检查 Todo：有工作已完成全部 Checklist，但自动创建人类验收 Todo 失败。请刷新并向用户报告具体错误；源任务仍保持未完成，不要重复执行 Checklist。"
          : newAcceptanceFeedbackKeys.length
            ? "检查 Todo：定时轮询发现待验收任务有新的用户评论。请同步并向用户逐条展示反馈，询问是否按评论创建新的返工工作继续处理；未经用户明确确认不得执行评论内容，也不要修改已经完成的源任务 Checklist。"
            : "检查 Todo：定时轮询发现已设置优先级的普通未完成工作，请同步并按顺序执行；无优先级任务视为草稿并静默跳过。执行过程中更新 Todo，完成后继续下一个工作，直到队列为空或需要用户确认。",
        { deliverAs: "followUp" },
      );

    } finally {
      running = false;
    }
  };
  const reportPollError = (error: unknown) => {
    // Polling is opportunistic: a remote outage must never become an unhandled
    // rejection that terminates Pi. Foreground actions surface their own errors.
    if (process.env.PI_DIDA_TODO_DEBUG === "1") console.error("dida-todo poll failed", error);
  };
  void poll().catch(reportPollError);
  const timer = setInterval(() => { void poll().catch(reportPollError); }, intervalMinutes * 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
