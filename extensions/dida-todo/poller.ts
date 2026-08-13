import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { TODO_AUTO_POLL_PREFIX } from "./input-sync.js";
import {
  getSessionRuntime,
  pendingWorkFinalizations,
  setAllowedTrackingReasons,
  setQueueCheckPermission,
  updateSessionWork,
  updateSessionWorks,
} from "./runtime.js";
import { formatWorkQueueForAgent, isExecutableWork, rankExecutableWorks } from "./work-queue.js";

export interface PollState {
  idle: boolean;
  hasPendingMessages: boolean;
  boundWorkId?: string;
  remoteWorkIds: string[];
  pendingAcceptanceIds?: string[];
}

export function pollDecision(state: PollState): "silent" | "trigger" {
  if (!state.idle || state.hasPendingMessages) return "silent";
  return state.remoteWorkIds.length > 0 ? "trigger" : "silent";
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
    if (!runtime || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    running = true;
    try {
      const sync = await repository.syncOpenWorks(runtime.scope, {
        adoptUnmanaged: true,
        deferFinalizationWorkIds: pendingWorkFinalizations(sessionId),
      });
      const executableWorks = sync.works.filter(isExecutableWork);
      const finalizationFailureIds = sync.finalizationFailures.map((failure) => failure.workId);
      updateSessionWorks(sessionId, sync.works, runtime.work?.remote.id);
      if (pollDecision({
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        boundWorkId: getSessionRuntime(sessionId)?.work?.remote.id,
        remoteWorkIds: [...executableWorks.map((work) => work.remote.id), ...finalizationFailureIds],
        pendingAcceptanceIds: sync.acceptances.map(({ remote }) => remote.id),
      }) !== "trigger") {
        onWorkChanged();
        return;
      }

      const selected = selectPolledWork(executableWorks);
      if (selected) updateSessionWork(sessionId, selected);
      setAllowedTrackingReasons(sessionId, ["current_work_step"]);
      setQueueCheckPermission(sessionId, true);
      onWorkChanged();
      pi.sendUserMessage(
        [
          `${TODO_AUTO_POLL_PREFIX}此消息由 dida-todo 可信 Poller 生成，授权本轮同步、领取并按顺序执行所有符合条件的工作；不要处理 priority=0 草稿。`,
          "",
          formatWorkQueueForAgent(sync.works, sync.adoptedWorkIds.length, sync.acceptances, sync.finalizationFailures),
        ].join("\n"),
        { deliverAs: "followUp" },
      );
    } finally {
      running = false;
    }
  };
  const reportPollError = (error: unknown) => {
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
