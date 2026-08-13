import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { rankExecutableWorks } from "./work-queue.js";

export interface PollState {
  idle: boolean;
  hasPendingMessages: boolean;
  boundWorkId?: string;
  remoteWorkIds: string[];
  pendingAcceptanceIds?: string[];
}

export function pollDecision(_state: PollState): "silent" | "trigger" {
  // Ordinary work queues are user-driven. Only the exact foreground phrase
  // `检查todo` may authorize scanning and execution; the legacy poller stays
  // permanently silent for backward-compatible imports/configuration.
  return "silent";
}

export function selectPolledWork(works: WorkTask[], now = new Date()): WorkTask | undefined {
  return rankExecutableWorks(works, now)[0];
}

export function startTodoPoller(
  _pi: ExtensionAPI,
  _ctx: ExtensionContext,
  _repository: DidaTodoRepository,
  intervalMinutes: number,
  _onWorkChanged: () => void,
): () => void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error("pollIntervalMinutes 必须是 1 到 1440 的整数");
  }
  // Kept as a compatibility seam for existing configuration and imports.
  // Queue scanning is now exclusively authorized by the exact user phrase
  // `检查todo`; startup and timers must not read Dida or wake the agent.
  return () => undefined;
}
