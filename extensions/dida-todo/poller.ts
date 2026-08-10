import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, updateSessionWork, updateSessionWorks } from "./runtime.js";

export interface PollState {
  idle: boolean;
  hasPendingMessages: boolean;
  currentWorkId?: string;
  remoteWorkIds: string[];
}

export function pollDecision(state: PollState): "silent" | "trigger" {
  if (!state.idle || state.hasPendingMessages || state.currentWorkId) return "silent";
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
    const decisionBeforeFetch = pollDecision({
      idle: ctx.isIdle(),
      hasPendingMessages: ctx.hasPendingMessages(),
      currentWorkId: runtime.work?.remote.id,
      remoteWorkIds: [],
    });
    if (decisionBeforeFetch === "silent" && (!ctx.isIdle() || ctx.hasPendingMessages() || runtime.work)) return;
    running = true;
    try {
      const sync = await repository.syncOpenWorks(runtime.scope, { adoptUnmanaged: true });
      if (pollDecision({
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        currentWorkId: getSessionRuntime(sessionId)?.work?.remote.id,
        remoteWorkIds: sync.works.map((work) => work.remote.id),
      }) !== "trigger") {
        updateSessionWorks(sessionId, sync.works, runtime.work?.remote.id);
        return;
      }
      const selected = selectPolledWork(sync.works);
      if (!selected) return;
      updateSessionWorks(sessionId, sync.works, selected.remote.id);
      updateSessionWork(sessionId, selected);
      onWorkChanged();
      pi.sendUserMessage("检查 Todo：定时轮询发现新的未完成工作，请同步并执行；如果任务存在歧义或风险，先询问用户。", { deliverAs: "followUp" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void poll(), intervalMinutes * 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
