import type { TodoScope, WorkTask } from "./domain.js";
import type { DidaTodoRepository } from "./repository.js";
import { isWorkReadyForFinalization } from "./work-type.js";

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
  if (!visible.length || !visible.every((task) => task.status === "completed" || task.status === "skipped") || !isWorkReadyForFinalization(work)) {
    return { state: "not-ready", work };
  }
  await repository.finishWork(scope, workId, signal);
  return { state: "finalized", work: { ...work, remote: { ...work.remote, status: 2 } } };
}
