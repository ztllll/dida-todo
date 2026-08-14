import { occurrenceKeyForTask } from "./scheduling.js";
import type { DidaTask, DidaWorkType, PersistedWorkMetadata, TodoScope, WorkLifecycleState, WorkMetadata, WorkOrigin, WorkTask } from "./domain.js";
import { inferWorkType } from "./work-type.js";

function now(): string {
  return new Date().toISOString();
}

function hostId(): string {
  return process.env.HOSTNAME?.trim() || "unknown-host";
}

function v3Base(metadata: Exclude<PersistedWorkMetadata, WorkMetadata>, origin: WorkOrigin, lifecycle: WorkLifecycleState): WorkMetadata {
  return {
    ...metadata,
    schemaVersion: 3,
    kind: "dida-todo-work",
    origin,
    lifecycle,
    tasks: metadata.tasks.map((task) => ({ ...task })),
  };
}

export function migrateWorkMetadata(metadata: PersistedWorkMetadata): WorkMetadata {
  if (metadata.schemaVersion === 3) return { ...metadata, tasks: metadata.tasks.map((task) => ({ ...task })) };
  if (metadata.schemaVersion === 2) {
    return {
      ...v3Base(metadata, metadata.origin === "pi" ? "agent" : "dida", metadata.lifecycle),
      migratedFromVersion: metadata.migratedFromVersion ?? 2,
    };
  }
  // V1 lacks lifecycle provenance. Preserve it as a non-executable draft,
  // with an explicit marker for safe legacy finalization recovery.
  return { ...v3Base(metadata, "dida", "draft"), migratedFromVersion: 1 };
}

export function createAgentWorkMetadata(scope: TodoScope, workType: DidaWorkType = "checklist"): WorkMetadata {
  return {
    schemaVersion: 3,
    kind: "dida-todo-work",
    bindingKey: scope.bindingKey,
    origin: "agent",
    lifecycle: "claimed",
    workType,
    execution: {
      claimedAt: now(),
      owner: { hostId: hostId(), sessionId: scope.sessionId },
    },
    nextId: 1,
    tasks: [],
    sessionIds: [scope.sessionId],
    ...(scope.tmuxTarget ? { tmuxTarget: scope.tmuxTarget } : {}),
    cwd: scope.cwd,
  };
}

export function claimDidaWork(metadata: PersistedWorkMetadata, remote: DidaTask, scope: TodoScope): WorkMetadata {
  const current = migrateWorkMetadata(metadata);
  const workType = current.workType ?? inferWorkType(remote);
  if ((remote.priority ?? 0) <= 0) return { ...current, origin: "dida", lifecycle: "draft", workType };
  return {
    ...current,
    origin: "dida",
    lifecycle: "claimed",
    workType,
    execution: {
      occurrence: occurrenceKeyForTask(remote),
      claimedAt: now(),
      owner: { hostId: hostId(), sessionId: scope.sessionId },
    },
  };
}

export function claimCurrentOccurrence(metadata: PersistedWorkMetadata, remote: DidaTask, scope: TodoScope): WorkMetadata {
  const current = migrateWorkMetadata(metadata);
  if (current.origin === "dida" && (remote.priority ?? 0) <= 0) return current;
  const occurrence = occurrenceKeyForTask(remote);
  if (current.execution?.occurrence === occurrence && current.lifecycle !== "finalized") return current;
  return {
    ...current,
    lifecycle: "claimed",
    execution: {
      occurrence,
      claimedAt: now(),
      owner: { hostId: hostId(), sessionId: scope.sessionId },
    },
    finalization: undefined,
  };
}

export function canFinalizeWork(work: WorkTask): boolean {
  const metadata = migrateWorkMetadata(work.metadata);
  if ((work.remote.priority ?? 0) <= 0 && metadata.origin !== "agent") return false;
  if (metadata.lifecycle === "draft" || metadata.lifecycle === "finalized") return false;
  return metadata.execution?.occurrence === occurrenceKeyForTask(work.remote);
}

export function readyForAcceptance(metadata: PersistedWorkMetadata): WorkMetadata {
  return { ...migrateWorkMetadata(metadata), lifecycle: "ready_for_acceptance" };
}

export function finalized(metadata: PersistedWorkMetadata, remote: DidaTask, acceptanceId: string): WorkMetadata {
  return {
    ...migrateWorkMetadata(metadata),
    lifecycle: "finalized",
    finalization: {
      occurrence: occurrenceKeyForTask(remote),
      acceptanceId,
      commentWritten: true,
      sourceCompleted: true,
    },
  };
}
