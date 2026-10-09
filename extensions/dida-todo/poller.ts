import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { TODO_AUTO_POLL_PREFIX } from "./input-sync.js";
import {
  getSessionRuntime,
  pendingWorkFinalizations,
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

/** 队列指纹：任何进展、用户编辑、新 occurrence 或优先级变化都会改变它。 */
export function queueFingerprint(works: WorkTask[], failureIds: string[] = []): string {
  return JSON.stringify([
    works.map((work) => [
      work.remote.id,
      work.remote.modifiedTime ?? "",
      work.remote.priority ?? 0,
      work.remote.startDate ?? work.remote.dueDate ?? "",
      work.tasks.map((task) => task.status).join(","),
    ]),
    failureIds,
  ]);
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
  // shortcut: 只在内存中记录，重启 Pi 后会重新触发一次；足以阻止同一进程内每 10 分钟重复刷屏。
  let lastTriggered: string | undefined;

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

      // 上次触发后队列毫无变化（Agent 没推进、人类也没动）就不再重复唤醒，避免卡住的任务刷屏。
      const fingerprint = queueFingerprint(executableWorks, finalizationFailureIds);
      if (fingerprint === lastTriggered) {
        onWorkChanged();
        return;
      }
      lastTriggered = fingerprint;
      const selected = selectPolledWork(executableWorks);
      if (selected) updateSessionWork(sessionId, selected);
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
