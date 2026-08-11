import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostLockPath } from "../../extensions/dida-todo/host-lock.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(script: string, key: string, holdMs: number): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["./node_modules/vite-node/vite-node.mjs", script, key, String(holdMs)], {
      cwd: resolve(import.meta.dirname, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
}

describe("同宿主跨进程锁", () => {
  it("会清理崩溃进程遗留的锁目录", async () => {
    const key = `orphan:${Date.now()}:${Math.random()}`;
    const path = hostLockPath(key);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "owner.json"), JSON.stringify({ token: "dead", pid: 999_999_999 }));
    const worker = join(await mkdtemp(join(tmpdir(), "dida-host-lock-orphan-")), "worker.ts");
    await writeFile(worker, `import { withHostLock } from ${JSON.stringify(resolve(import.meta.dirname, "../../extensions/dida-todo/host-lock.ts"))}; await withHostLock(process.argv[2]!, async () => {});`);
    try {
      await run(worker, key, 0);
    } finally {
      await rm(path, { recursive: true, force: true });
      await rm(resolve(worker, ".."), { recursive: true, force: true });
    }
  });

  it("两个独立 Node 进程以同一键写入时严格串行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dida-host-lock-"));
    const script = join(directory, "worker.ts");
    const lockModule = resolve(import.meta.dirname, "../../extensions/dida-todo/host-lock.ts");
    await writeFile(script, [
      `import { withHostLock } from ${JSON.stringify(lockModule)};`,
      "const [, , key, hold] = process.argv;",
      "await withHostLock(key!, async () => { console.log(`enter:${process.pid}:${Date.now()}`); await new Promise((done) => setTimeout(done, Number(hold))); console.log(`leave:${process.pid}:${Date.now()}`); });",
    ].join("\n"));
    const key = `test:${Date.now()}:${Math.random()}`;
    try {
      const first = run(script, key, 180);
      await new Promise((done) => setTimeout(done, 30));
      const second = run(script, key, 0);
      const [firstOut, secondOut] = await Promise.all([first, second]);
      const times = [firstOut, secondOut].flatMap((output) => output.trim().split("\n")).map((line) => {
        const [, state, pid, timestamp] = line.match(/(enter|leave):(\d+):(\d+)/) ?? [];
        return { state, pid, timestamp: Number(timestamp) };
      });
      const eventsByPid = new Map<string, Array<{ state: string; timestamp: number }>>();
      for (const event of times) eventsByPid.set(event.pid, [...(eventsByPid.get(event.pid) ?? []), event]);
      expect(eventsByPid).toHaveLength(2);
      const windows = [...eventsByPid.values()].map((events) => ({
        enter: events.find((event) => event.state === "enter")!.timestamp,
        leave: events.find((event) => event.state === "leave")!.timestamp,
      })).sort((a, b) => a.enter - b.enter);
      expect(windows[1]!.enter).toBeGreaterThanOrEqual(windows[0]!.leave);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
