import { describe, expect, it } from "vitest";
import didaTodo from "../../extensions/dida-todo/index.js";
import { getSessionRuntime, removeSessionRuntime } from "../../extensions/dida-todo/runtime.js";
import { loadConfig, resolveBinding } from "../../extensions/dida-todo/config.js";

describe("dbg2", () => {
  it("binding", async () => {
    const config = await loadConfig();
    const b1 = resolveBinding(config, "/home/pyadmin/dida-todo", "pi-didatodo:0.0");
    console.log("binding with tmux:", JSON.stringify(b1));
    const b2 = resolveBinding(config, "/home/pyadmin/dida-todo");
    console.log("binding cwd only:", JSON.stringify(b2?.key));
    expect(true).toBe(true);
  });
  it("session_start flow", async () => {
    const handlers = new Map<string, (e: unknown, ctx: any) => unknown>();
    await didaTodo({
      registerTool() {}, registerCommand() {}, registerShortcut() {},
      on(event: string, handler: (e: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
      async exec(command: string, args: string[]) {
        if (command === "tmux") return { code: 0, stdout: "pi-didatodo:0.0\n", stderr: "", killed: false };
        throw new Error("dida CLI 超时");
      },
    } as never);
    const notifications: string[] = [];
    const ctx = {
      cwd: "/home/pyadmin/dida-todo", hasUI: true, mode: "tui", signal: undefined,
      isIdle: () => false, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "dbg2-session" },
      ui: { notify: (m: string) => { notifications.push(m); }, setWidget() {} },
    };
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    console.log("runtime:", JSON.stringify(getSessionRuntime("dbg2-session") ? "SET" : "UNSET"));
    console.log("notifications:", JSON.stringify(notifications));
    removeSessionRuntime("dbg2-session");
    expect(true).toBe(true);
  });
});
