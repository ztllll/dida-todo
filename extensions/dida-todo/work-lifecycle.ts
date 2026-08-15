import { occurrenceKeyForTask } from "./scheduling.js";
import type { DidaTask, DidaWorkType, TodoScope, WorkLifecycleState, WorkMetadata, WorkMetadataV2, WorkOrigin, WorkTask } from "./domain.js";
import { inferWorkType } from "./work-type.js";

function now(): string {
  return new Date().toISOString();
}

function hostId(): string {
  return process.env.HOSTNAME?.trim() || "unknown-host";
}

function v2Base(metadata: WorkMetadata, origin: WorkOrigin, lifecycle: WorkLifecycleState): WorkMetadataV2 {
  return {
    ...metadata,
    schemaVersion: 2,
    kind: "pi-todo-work",
    origin,
    lifecycle,
  };
}

export function migrateWorkMetadata(metadata: WorkMetadata): WorkMetadataV2 {
  if (metadata.schemaVersion === 2) return { ...metadata, tasks: metadata.tasks.map((task) => ({ ...task })) };
  // v1 lacks lifecycle provenance. Preserve it as a non-executable draft,
  // but retain an explicit migration marker for safe legacy finalization recovery.
  return { ...v2Base(metadata, "dida", "draft"), migratedFromVersion: 1 };
}

export function createPiWorkMetadata(scope: TodoScope, workType: DidaWorkType = "checklist"): WorkMetadataV2 {
  return {
    schemaVersion: 2,
    kind: "pi-todo-work",
    bindingKey: scope.bindingKey,
    origin: "pi",
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

export function claimDidaWork(metadata: WorkMetadata, remote: DidaTask, scope: TodoScope): WorkMetadataV2 {
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

export function claimCurrentOccurrence(metadata: WorkMetadata, remote: DidaTask, scope: TodoScope): WorkMetadataV2 {
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
  if ((work.remote.priority ?? 0) <= 0 && metadata.origin !== "pi") return false;
  if (metadata.lifecycle === "draft" || metadata.lifecycle === "finalized") return false;
  const claimedOccurrence = metadata.execution?.occurrence;
  const currentOccurrence = occurrenceKeyForTask(work.remote);
  return claimedOccurrence === currentOccurrence;
}

export function readyForAcceptance(metadata: WorkMetadata): WorkMetadataV2 {
  return { ...migrateWorkMetadata(metadata), lifecycle: "ready_for_acceptance" };
}

export function finalized(metadata: WorkMetadata, remote: DidaTask, acceptanceId: string): WorkMetadataV2 {
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
