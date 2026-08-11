import { mkdtemp } from "node:fs/promises";
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
  it("登录动作完成 OAuth 后自动 provisioning 并立即激活", async () => {
    const configPath = join(await mkdtemp(join(tmpdir(), "dida-setup-tool-")), "config.json");
    let tool: any;
    const pi = { registerTool(value: any) { tool = value; } } as never;
    const gateway = new Gateway();
    const config: DidaTodoConfig = { bindings: [] };
    let activated = "";
    registerDidaSetupTool(
      pi,
      gateway as never,
      config,
      () => ({ cwd: "/workspace/demo", tmuxTarget: "demo:0.0" }),
      async (_ctx, binding) => { activated = binding.projectId; },
      configPath,
    );

    const result = await tool.execute("id", { action: "login" }, undefined, undefined, {
      cwd: "/workspace/demo",
      sessionManager: { getSessionId: () => "session" },
    });

    expect(gateway.loginCalls).toBe(1);
    expect(activated).toBe("created");
    expect(result.content[0].text).toContain("滴答登录完成");
    expect(result.content[0].text).toContain("立即生效");
    expect(result.content[0].text).toContain("无需 /reload");
    expect(result.details.ready).toBe(true);
    expect(config.bindings).toHaveLength(2);
  });
});
