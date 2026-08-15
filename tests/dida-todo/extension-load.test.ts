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
