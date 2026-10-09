// 进程内按 key 串行化（跨进程互斥由 host-lock 负责）。宿主无关，Pi 与 dsh 共用。
const queues = new Map<string, Promise<void>>();

export async function withMutationQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  queues.set(key, chained);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key);
  }
}
