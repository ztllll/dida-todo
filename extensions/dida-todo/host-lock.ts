import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_MS = 20;

function lockName(key: string): string {
  return `pi-dida-todo-${createHash("sha256").update(key).digest("hex")}.lock`;
}

export function hostLockPath(key: string): string {
  return join(tmpdir(), lockName(key));
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function ownerProcessIsGone(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    const pid = owner.pid;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function release(path: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as { token?: string };
    if (owner.token === token) await rm(path, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A same-host process lock. The `pi-dida-todo-` prefix is a frozen cross-version
 * protocol, so Pi and OMP runtimes serialize against the same lock during upgrade. */
export async function withHostLock<T>(key: string, action: () => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const path = hostLockPath(key);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(join(path, "owner.json"), JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await ownerProcessIsGone(path)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待同宿主锁超时: ${key}`);
      await sleep(RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    await release(path, token);
  }
}
