import { readFileSync } from "node:fs";
import type { Task, TodoScope, WorkTask } from "./domain.js";
import { createPiWorkMetadata } from "./work-lifecycle.js";

interface TodoToolCallEntry {
  message?: { role?: string; name?: string; toolName?: string; isError?: boolean; arguments?: { workTitle?: string }; details?: { didaWorkTaskId?: string; didaProjectId?: string; nextId?: number; tasks?: Task[]; params?: { workTitle?: string } } };
}

interface TodoSnapshot {
  workId: string;
  projectId?: string;
  nextId: number;
  tasks: Task[];
  workTitle?: string;
}

export function readLastTodoSnapshot(sessionFile: string): TodoSnapshot | undefined {
  let lines: string[];
  try {
    lines = readFileSync(sessionFile, "utf8").split("\n");
  } catch {
    return undefined;
  }
  let snapshot: TodoSnapshot | undefined;
  let pendingWorkTitle: string | undefined;
  for (const line of lines) {
    if (!line.includes('"todo"')) continue;
    let entry: TodoToolCallEntry;
    try {
      entry = JSON.parse(line) as TodoToolCallEntry;
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message) continue;
    if (message.role === "toolCall" && message.name === "todo") {
      const workTitle = message.arguments?.workTitle;
      if (typeof workTitle === "string" && workTitle.trim()) pendingWorkTitle = workTitle.trim();
      continue;
    }
    if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
    const details = message.details;
    if (!details?.didaWorkTaskId || !Array.isArray(details.tasks) || details.tasks.length === 0) continue;
    snapshot = {
      workId: details.didaWorkTaskId,
      ...(details.didaProjectId ? { projectId: details.didaProjectId } : {}),
      nextId: details.nextId ?? details.tasks.length + 1,
      tasks: details.tasks,
      ...(details.params?.workTitle?.trim() ? { workTitle: details.params.workTitle.trim() } : pendingWorkTitle ? { workTitle: pendingWorkTitle } : {}),
    };
  }
  return snapshot;
}

export function replayTodoWork(sessionFile: string, scope: TodoScope): WorkTask | undefined {
  const snapshot = readLastTodoSnapshot(sessionFile);
  if (!snapshot) return undefined;
  if (snapshot.projectId && snapshot.projectId !== scope.binding.projectId) return undefined;
  const metadata = {
    ...createPiWorkMetadata(scope, "checklist"),
    nextId: snapshot.nextId,
    tasks: snapshot.tasks,
  };
  return {
    remote: {
      id: snapshot.workId,
      projectId: scope.binding.projectId,
      title: snapshot.workTitle ?? "",
      status: 0,
      priority: 0,
    },
    metadata,
    tasks: snapshot.tasks,
    userContent: "",
  };
}
