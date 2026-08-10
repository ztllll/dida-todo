import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, updateSessionWork, updateSessionWorks } from "./runtime.js";

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

export function selectPolledWork(works: WorkTask[]): WorkTask | undefined {
  return [...works].sort((left, right) => {
    const priority = (right.remote.priority ?? 0) - (left.remote.priority ?? 0);
    if (priority !== 0) return priority;
    return String(right.remote.createdTime ?? "").localeCompare(String(left.remote.createdTime ?? ""));
  })[0];
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
      if (pollDecision({
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        boundWorkId: getSessionRuntime(sessionId)?.work?.remote.id,
        remoteWorkIds: sync.works.map((work) => work.remote.id),
        pendingAcceptanceIds: sync.acceptances.map(({ remote }) => remote.id),
      }) !== "trigger") {
        updateSessionWorks(sessionId, sync.works, runtime.work?.remote.id);
        return;
      }
      const selected = selectPolledWork(sync.works);
      updateSessionWorks(sessionId, sync.works, selected?.remote.id);
      if (selected) updateSessionWork(sessionId, selected);
      onWorkChanged();
      pi.sendUserMessage(
        "检查 Todo：定时轮询发现普通未完成工作，请同步并按顺序执行；执行过程中更新 Todo，完成后继续下一个工作，直到队列为空或需要用户确认。",
        { deliverAs: "followUp" },
      );
    } finally {
      running = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), intervalMinutes * 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
