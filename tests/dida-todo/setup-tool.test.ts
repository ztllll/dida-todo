import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DidaProject, DidaTodoConfig } from "../../extensions/dida-todo/domain.js";
import { registerDidaSetupTool } from "../../extensions/dida-todo/setup-tool.js";

class Gateway {
  projects: DidaProject[] = [];
  loginCalls = 0;
  async login() { this.loginCalls += 1; return "ok"; }
  async listProjects() { return this.projects; }
  async createProject(name: string) {
    const project = { id: "created", name };
    this.projects.push(project);
    return project;
  }
}

describe("LLM setup tool", () => {
  it("登录后按用户输入的分组名称创建并立即激活", async () => {
    const configPath = join(await mkdtemp(join(tmpdir(), "dida-setup-tool-")), "config.json");
    let tool: any;
    const gateway = new Gateway();
    const config: DidaTodoConfig = { bindings: [] };
    let activated = "";
    registerDidaSetupTool(
      { registerTool(value: any) { tool = value; } } as never,
      gateway as never,
      config,
      () => ({ cwd: "/workspace/demo", tmuxTarget: "demo:0.0" }),
      async (_ctx, binding) => { activated = binding.projectId; },
      configPath,
    );

    const result = await tool.execute("id", { action: "login" }, undefined, undefined, {
      cwd: "/workspace/demo",
      hasUI: true,
      ui: { input: async () => "用户指定分组" },
      sessionManager: { getSessionId: () => "session" },
    });

    expect(gateway.loginCalls).toBe(1);
    expect(gateway.projects).toEqual([{ id: "created", name: "用户指定分组" }]);
    expect(activated).toBe("created");
    expect(result.details.ready).toBe(true);
    expect(config.bindings).toHaveLength(2);
  });

  it("登录后取消分组输入时不创建也不绑定", async () => {
    let tool: any;
    const gateway = new Gateway();
    registerDidaSetupTool(
      { registerTool(value: any) { tool = value; } } as never,
      gateway as never,
      { bindings: [] },
      () => ({ cwd: "/workspace/demo" }),
      async () => {},
      join(await mkdtemp(join(tmpdir(), "dida-setup-cancel-")), "config.json"),
    );

    const result = await tool.execute("id", { action: "login" }, undefined, undefined, {
      cwd: "/workspace/demo",
      hasUI: true,
      ui: { input: async () => undefined },
      sessionManager: { getSessionId: () => "session" },
    });

    expect(result.details.ready).toBe(false);
    expect(gateway.projects).toEqual([]);
  });

  it("显式 bind 只使用其被动 cwd 上下文，不继承 Interactive tmux pane", async () => {
    const configPath = join(await mkdtemp(join(tmpdir(), "dida-setup-print-")), "config.json");
    let tool: any;
    const gateway = new Gateway();
    gateway.projects.push({ id: "existing", name: "已有分组" });
    registerDidaSetupTool(
      { registerTool(value: any) { tool = value; } } as never,
      gateway as never,
      { bindings: [] },
      () => ({ cwd: "/workspace/print" }),
      async () => {},
      configPath,
    );

    await tool.execute("id", { action: "bind", projectName: "已有分组" }, undefined, undefined, {
      cwd: "/workspace/print",
      hasUI: false,
      sessionManager: { getSessionId: () => "print-session" },
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.bindings).toEqual([expect.objectContaining({ key: "cwd:/workspace/print", projectId: "existing" })]);
  });
});
