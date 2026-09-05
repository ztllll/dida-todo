import { describe, expect, it } from "vitest";
import { createExtensionRuntime, loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import didaTodo, { initializePassiveSession } from "../../extensions/dida-todo/index.js";
import { getSessionRuntime, removeSessionRuntime } from "../../extensions/dida-todo/runtime.js";

describe("dida-todo Extension 生命周期", () => {
  it("扩展工厂不得在 Runtime 绑定前调用 action API", async () => {
    const entry = new URL("../../extensions/dida-todo/index.ts", import.meta.url).pathname;
    const result = await loadExtensions([entry], new URL("../..", import.meta.url).pathname, undefined, createExtensionRuntime());
    expect(result.errors).toEqual([]);
    expect(result.extensions.map((extension) => extension.path)).toEqual([entry]);
  });

  it("Print/RPC 被动 Runtime 只复用 cwd binding，不继承 tmux binding", () => {
    const sessionId = "passive-runtime";
    try {
      expect(initializePassiveSession({ bindings: [
        { key: "tmux:production:0.0", projectId: "tmux-project", cwd: "/workspace/demo" },
        { key: "cwd:/workspace/demo", projectId: "cwd-project", cwd: "/workspace/demo" },
      ] }, "/workspace/demo", sessionId)).toBe(true);
      expect(getSessionRuntime(sessionId)?.scope.binding.projectId).toBe("cwd-project");
      expect(getSessionRuntime(sessionId)?.works).toEqual([]);
    } finally {
      removeSessionRuntime(sessionId);
    }
  });

  it("已绑定 TUI session_start 同步滴答并初始化 Runtime", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    let projectDataCalls = 0;
    await didaTodo({
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
      async exec(command: string, args: string[]) {
        if (command === "tmux") return { code: 0, stdout: "pi-didatodo:0.0\n", stderr: "", killed: false };
        if (args.join(" ") === "project data 6a799f4de4b050c704b321b2 --json") {
          projectDataCalls += 1;
          return { code: 0, stdout: JSON.stringify({ project: { id: "6a799f4de4b050c704b321b2", name: "已绑定分组" }, tasks: [], columns: [] }), stderr: "", killed: false };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    } as never);

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      cwd: "/home/pyadmin/dida-todo",
      hasUI: true,
      mode: "tui",
      signal: undefined,
      isIdle: () => false,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "bound-tui" },
      ui: { notify() {}, setWidget() {} },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(projectDataCalls).toBe(1);
    expect(getSessionRuntime("bound-tui")?.scope.binding.projectId).toBe("6a799f4de4b050c704b321b2");
    removeSessionRuntime("bound-tui");
  });

  it("未绑定的 Web/RPC session_start 保持被动，不访问滴答或阻塞输入", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let execCalls = 0;
    let inputCalls = 0;
    await didaTodo({
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
      async exec() { execCalls += 1; throw new Error("未绑定启动不应执行外部命令"); },
    } as never);

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      cwd: "/workspace/unbound-rpc",
      hasUI: true,
      mode: "rpc",
      sessionManager: { getSessionId: () => "unbound-rpc" },
      ui: { input: async () => { inputCalls += 1; return "不应请求"; }, notify() {} },
    });

    expect(execCalls).toBe(0);
    expect(inputCalls).toBe(0);
    expect(getSessionRuntime("unbound-rpc")).toBeUndefined();
  });

  it("未绑定 Interactive session_start 不查询登录状态，只提示显式绑定", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    let authCalls = 0;
    let projectListCalls = 0;
    await didaTodo({
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
      async exec(command: string, args: string[]) {
        if (command === "tmux") return { code: 0, stdout: "pi-passive-regression:0.0\n", stderr: "", killed: false };
        if (args.join(" ") === "project list --json") { projectListCalls += 1; return { code: 1, stdout: "", stderr: "未找到 access token", killed: false }; }
        if (args.join(" ") === "auth login") { authCalls += 1; return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "unexpected", killed: false };
      },
    } as never);
    const sessionStart = handlers.get("session_start")!;
    const notifications: string[] = [];
    await sessionStart({ type: "session_start", reason: "startup" }, {
      cwd: "/workspace/unbound",
      hasUI: true,
      mode: "tui",
      signal: undefined,
      sessionManager: { getSessionId: () => "unbound-login" },
      ui: {
        confirm: async () => false,
        notify: (message: string) => notifications.push(message),
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(authCalls).toBe(0);
    expect(projectListCalls).toBe(0);
    removeSessionRuntime("unbound-login");
  });

  it("Print/RPC session_start 不访问 tmux、滴答或 provisioning", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let execCalls = 0;
    await didaTodo({
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
      async exec() { execCalls += 1; throw new Error("非 UI session 不应调用 exec"); },
    } as never);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeDefined();
    await sessionStart?.({ type: "session_start", reason: "startup" }, {
      cwd: "/home/pyadmin/dida-todo",
      hasUI: false,
      sessionManager: { getSessionId: () => "print-session" },
    });
    expect(execCalls).toBe(0);
  });
});
