import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import didaTodo from "../../extensions/dida-todo/index.js";

const TestType = {
  Array: () => undefined,
  Boolean: () => undefined,
  Literal: (_value: string) => undefined,
  Number: () => undefined,
  Object: () => undefined,
  Optional: <Schema>(schema: Schema) => schema,
  Record: () => undefined,
  String: () => undefined,
  Union: () => undefined,
  Unknown: () => undefined,
};

describe("dida-todo Extension 生命周期", () => {
  it("扩展工厂不得在 Runtime 绑定前调用 action API", async () => {
    const entry = new URL("../../extensions/dida-todo/index.ts", import.meta.url).pathname;
    const result = await loadExtensions([entry], new URL("../..", import.meta.url).pathname);
    expect(result.errors).toEqual([]);
    expect(result.extensions.map((extension) => extension.path)).toEqual([entry]);
  });

  it("Interactive/TUI session_start activates Dida tools and routing", async () => {
    const configPath = join(await mkdtemp(join(tmpdir(), "dida-extension-start-")), "config.json");
    await writeFile(configPath, JSON.stringify({ bindings: [], autoProvisionProject: false }));
    const previousConfigPath = process.env.OMP_DIDA_TODO_CONFIG_PATH;
    const previousTmuxPane = process.env.TMUX_PANE;
    process.env.OMP_DIDA_TODO_CONFIG_PATH = configPath;
    delete process.env.TMUX_PANE;

    try {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      let activeTools: string[] = [];
      await didaTodo({
        typebox: { Type: TestType },
        registerTool() {},
        registerCommand() {},
        registerShortcut() {},
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
        getActiveTools() { return activeTools; },
        async setActiveTools(tools: string[]) { activeTools = [...tools]; },
      } as never);
      const sessionId = "interactive-start-session";
      const ctx = {
        cwd: "/workspace/demo",
        hasUI: true,
        sessionManager: { getSessionId: () => sessionId },
        ui: {},
      };
      const sessionStart = handlers.get("session_start");
      const beforeAgentStart = handlers.get("before_agent_start");
      if (!sessionStart || !beforeAgentStart) throw new Error("Dida lifecycle handlers were not registered");

      await sessionStart({ type: "session_start" }, ctx);
      const route = await beforeAgentStart({ type: "before_agent_start", systemPrompt: ["base"] }, ctx) as { systemPrompt?: string[] } | undefined;

      expect(activeTools).toEqual(["dida_todo", "dida_todo_work", "dida_todo_setup"]);
      expect(route?.systemPrompt?.join("\n")).toContain("Dida routing contract:");
    } finally {
      if (previousConfigPath === undefined) delete process.env.OMP_DIDA_TODO_CONFIG_PATH;
      else process.env.OMP_DIDA_TODO_CONFIG_PATH = previousConfigPath;
      if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousTmuxPane;
    }
  });
});
