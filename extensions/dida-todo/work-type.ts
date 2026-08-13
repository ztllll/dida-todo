import type { DidaTask, DidaWorkType, WorkMetadata, WorkTask } from "./domain.js";

export function inferWorkType(remote: DidaTask): DidaWorkType {
  return (remote.items?.length ?? 0) > 0 || remote.kind === "CHECKLIST" ? "checklist" : "direct";
}

export function workTypeOf(work: Pick<WorkTask, "metadata" | "remote">): DidaWorkType {
  return workTypeOfMetadata(work.metadata, work.remote);
}

export function workTypeOfMetadata(metadata: WorkMetadata, remote: DidaTask): DidaWorkType {
  return metadata.schemaVersion === 2 && metadata.workType ? metadata.workType : inferWorkType(remote);
}

export function requiresExplicitWorkCompletion(work: Pick<WorkTask, "metadata" | "remote">): boolean {
  const metadata = work.metadata.schemaVersion === 2 ? work.metadata : undefined;
  return metadata?.workType === "checklist" && metadata.origin === "pi" && metadata.migratedFromVersion !== 1;
}

export function isWorkReadyForFinalization(work: Pick<WorkTask, "metadata" | "remote">): boolean {
  if (!requiresExplicitWorkCompletion(work)) return true;
  return work.metadata.schemaVersion === 2 && work.metadata.lifecycle === "ready_for_acceptance";
}
