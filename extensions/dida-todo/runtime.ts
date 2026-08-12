import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Task, TodoScope, WorkTask } from "./domain.js";
import { isExecutableWork } from "./work-queue.js";

export interface SessionRuntime {
  scope: TodoScope;
  work?: WorkTask;
  works: WorkTask[];
  lastSyncAt?: string;
  pendingAcceptanceResultSources?: WorkTask["remote"][];
  latestFinalResponse?: string;
}

const sessions = new Map<string, SessionRuntime>();
let activeSessionId = "";
let ui: ExtensionUIContext | undefined;

export function setSessionRuntime(sessionId: string, runtime: SessionRuntime): void {
  sessions.set(sessionId, runtime);
}

export function getSessionRuntime(sessionId: string): SessionRuntime | undefined {
  return sessions.get(sessionId);
}

export function updateSessionWork(sessionId: string, work: WorkTask | undefined): void {
  const runtime = sessions.get(sessionId);
  if (!runtime) throw new Error(`Pi session ${sessionId} 尚未初始化滴答 Todo`);
  runtime.work = work;
  if (work) {
    const index = runtime.works.findIndex((candidate) => candidate.remote.id === work.remote.id);
    if (index >= 0) runtime.works[index] = work;
    else runtime.works.unshift(work);
  }
}

export function updateSessionWorks(sessionId: string, works: WorkTask[], preferredWorkId?: string): void {
  const runtime = sessions.get(sessionId);
  if (!runtime) throw new Error(`Pi session ${sessionId} 尚未初始化滴答 Todo`);
  runtime.works = works;
  runtime.lastSyncAt = new Date().toISOString();
  const targetId = preferredWorkId ?? runtime.work?.remote.id;
  const target = targetId ? works.find((work) => work.remote.id === targetId && isExecutableWork(work)) : undefined;
  const executable = works.filter(isExecutableWork);
  runtime.work = target ?? (executable.length === 1 ? executable[0] : undefined);
}

export function queueAcceptanceResultSource(sessionId: string, source: WorkTask["remote"]): void {
  const runtime = sessions.get(sessionId);
  if (!runtime) throw new Error(`Pi session ${sessionId} 尚未初始化滴答 Todo`);
  runtime.pendingAcceptanceResultSources ??= [];
  const key = `${source.id}:${source.startDate ?? source.dueDate ?? ""}`;
  if (!runtime.pendingAcceptanceResultSources.some((candidate) => `${candidate.id}:${candidate.startDate ?? candidate.dueDate ?? ""}` === key)) {
    runtime.pendingAcceptanceResultSources.push(structuredClone(source));
  }
}

export function setLatestFinalResponse(sessionId: string, response: string): void {
  const runtime = sessions.get(sessionId);
  if (!runtime) return;
  runtime.latestFinalResponse = response;
}

export function pendingAcceptanceResults(sessionId: string): { sources: WorkTask["remote"][]; finalResponse?: string } {
  const runtime = sessions.get(sessionId);
  return {
    sources: runtime?.pendingAcceptanceResultSources?.map((source) => structuredClone(source)) ?? [],
    ...(runtime?.latestFinalResponse ? { finalResponse: runtime.latestFinalResponse } : {}),
  };
}

export function clearPendingAcceptanceResults(sessionId: string): void {
  const runtime = sessions.get(sessionId);
  if (!runtime) return;
  runtime.pendingAcceptanceResultSources = [];
  delete runtime.latestFinalResponse;
}

export function removeSessionRuntime(sessionId: string): void {
  sessions.delete(sessionId);
  if (activeSessionId === sessionId) activeSessionId = "";
}

export function setActiveSession(sessionId: string, uiContext: ExtensionUIContext): void {
  activeSessionId = sessionId;
  ui = uiContext;
}

export function getActiveRuntime(): SessionRuntime | undefined {
  return activeSessionId ? sessions.get(activeSessionId) : undefined;
}

export function getActiveTasks(): Task[] {
  return getActiveRuntime()?.work?.tasks.map((task) => ({ ...task })) ?? [];
}

export function getActiveUI(): ExtensionUIContext | undefined {
  return ui;
}

export function clearActiveSession(sessionId: string): void {
  if (activeSessionId !== sessionId) return;
  activeSessionId = "";
  ui = undefined;
}
