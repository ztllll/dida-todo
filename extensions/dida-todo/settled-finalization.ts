import type { TodoScope, WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";

export type SettledFinalizationResult =
  | { state: "finalized"; work: WorkTask }
  | { state: "not-ready"; work: WorkTask };

export async function finalizeWorkAtSettlement(
  repository: DidaTodoRepository,
  scope: TodoScope,
  workId: string,
  signal?: AbortSignal,
): Promise<SettledFinalizationResult> {
  const work = await repository.getWork(scope, workId, signal);
  const visible = work.tasks.filter((task) => task.status !== "deleted");
  const keepOpen = work.metadata.schemaVersion === 2 && work.metadata.keepOpen === true;
  if (keepOpen || !visible.length || !visible.every((task) => task.status === "completed" || task.status === "skipped")) {
    return { state: "not-ready", work };
  }
  await repository.finishWork(scope, workId, signal);
  return { state: "finalized", work: { ...work, remote: { ...work.remote, status: 2 } } };
}
