import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import didaTodo from "../../extensions/dida-todo/index.js";
import { getActiveRuntime, getSessionRuntime, removeSessionRuntime } from "../../extensions/dida-todo/runtime.js";

const BOUND_CWD = "/home/pyadmin/dida-todo";
const BOUND_PROJECT = "6a799f4de4b050c704b321b2";

function fakePi(execImpl: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> | Promise<never>) {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const ready = didaTodo({
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
    async exec(command: string, args: string[]) {
      return execImpl(command, args);
    },
  } as never);
  return { ready, handlers };
}

function tuiCtx(sessionId: string) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    ctx: {
      cwd: BOUND_CWD,
      hasUI: true,
      mode: "tui",
      signal: undefined,
      isIdle: () => false,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: (message: string, level: string) => { notifications.push({ message, level }); }, setWidget() {} },
    },
    notifications,
  };
}

describe("session_start 韧性：面板挂载与临时 Runtime 不依赖同步成败", () => {
  it("resume 会话先重放上一个会话的 Todo 快照，同步未完成前工具与面板已可用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-session-start-"));
    const previousFile = join(dir, "previous.jsonl");
    await writeFile(previousFile, [
      JSON.stringify({ message: { role: "toolCall", name: "todo", arguments: { action: "create", workTitle: "重放工作", workType: "checklist" } } }),
      JSON.stringify({ message: { role: "toolResult", toolName: "todo", content: [], details: { didaWorkTaskId: "work-1", didaProjectId: BOUND_PROJECT, nextId: 3, tasks: [{ id: 1, subject: "步骤一", status: "pending" }] } } }),
    ].join("\n") + "\n");

    const { ready, handlers } = fakePi((command, args) => {
      if (command === "tmux") return Promise.resolve({ code: 0, stdout: "pi-didatodo:0.0\n", stderr: "", killed: false });
      void args;
      return new Promise<never>(() => {});
    });
    await ready;
    const { ctx } = tuiCtx("replay-session");

    await handlers.get("session_start")?.({ type: "session_start", reason: "resume", previousSessionFile: previousFile }, ctx);

    const runtime = getSessionRuntime("replay-session");
    expect(runtime?.work?.remote.id).toBe("work-1");
    expect(runtime?.work?.remote.title).toBe("重放工作");
    expect(runtime?.work?.tasks).toEqual([{ id: 1, subject: "步骤一", status: "pending" }]);
    expect(getActiveRuntime()).toBe(runtime);
    removeSessionRuntime("replay-session");
  });

  it("同步失败时 Runtime 与面板保持可用，Poller 仍启动自愈", async () => {
    const { ready, handlers } = fakePi((command, args) => {
      if (command === "tmux") return Promise.resolve({ code: 0, stdout: "pi-didatodo:0.0\n", stderr: "", killed: false });
      void args;
      return Promise.reject(new Error("dida CLI 超时"));
    });
    await ready;
    const { ctx, notifications } = tuiCtx("sync-fail-session");

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(getSessionRuntime("sync-fail-session")).toBeDefined();
    expect(getActiveRuntime()).toBe(getSessionRuntime("sync-fail-session"));
    const warning = notifications.find((item) => item.level === "warning");
    expect(warning?.message).toContain("Poller 会自动重试同步");
    removeSessionRuntime("sync-fail-session");
  });
});
