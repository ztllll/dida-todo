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
