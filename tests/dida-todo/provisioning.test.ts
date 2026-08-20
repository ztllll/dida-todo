import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DidaProject } from "../../extensions/dida-todo/domain.js";
import {
  bindExistingProject,
  deriveBindingIdentity,
  isDidaAuthenticationError,
  provisionPromptedProject,
  resolveAvailableProjectBinding,
} from "../../extensions/dida-todo/provisioning.js";

class ProjectGateway {
  created: string[] = [];
  constructor(public projects: DidaProject[]) {}
  async listProjects(): Promise<DidaProject[]> { return structuredClone(this.projects); }
  async createProject(name: string): Promise<DidaProject> {
    this.created.push(name);
    const project = { id: `project-${this.projects.length + 1}`, name, kind: "TASK", viewMode: "list" };
    this.projects.push(project);
    return structuredClone(project);
  }
}

describe("零配置项目清单 provisioning", () => {
  it("绑定标识保留用户输入的分组名，不从 cwd 或 tmux 推导名称", () => {
    const identity = deriveBindingIdentity("/workspace/demo", "老板指定分组", "my-project:2.1");

    expect(identity).toMatchObject({
      projectName: "老板指定分组",
      label: "老板指定分组",
      bindingKey: "tmux:my-project:2.1",
      cwdKey: "cwd:/workspace/demo",
    });
  });

  it("重新 provisioning 时替换同 cwd 的失效 tmux 绑定", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-stale-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      bindings: [
        { key: "tmux:demo:0.0", projectId: "deleted", cwd: "/workspace/demo", label: "deleted" },
        { key: "cwd:/workspace/demo", projectId: "existing", cwd: "/workspace/demo", label: "demo" },
      ],
    }));
    const gateway = new ProjectGateway([{ id: "existing", name: "demo", closed: false }]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const result = await resolveAvailableProjectBinding({ gateway, cwd: "/workspace/demo", tmuxTarget: "demo:0.0", configPath, config });

    expect(result.binding?.projectId).toBe("existing");
    expect(result.repaired).toBe(true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tmux:demo:0.0", projectId: "existing" }),
      expect.objectContaining({ key: "cwd:/workspace/demo", projectId: "existing" }),
    ]));
    expect(saved.bindings.some((binding: { projectId: string }) => binding.projectId === "deleted")).toBe(false);
  });

  it("同名清单不唯一时拒绝猜测，允许按 ID 显式绑定", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([{ id: "one", name: "demo" }, { id: "two", name: "demo" }]);
    await expect(provisionPromptedProject({ gateway, cwd: "/workspace/demo", configPath, prompt: async () => "demo" })).rejects.toThrow("存在 2 个同名清单");

    const bound = await bindExistingProject({ gateway, cwd: "/workspace/demo", configPath, projectId: "two" });
    expect(bound.binding.projectId).toBe("two");
  });

  it("用户输入分组名称时复用唯一同名分组，不自行派生名称", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-prompt-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([{ id: "existing", name: "老板指定分组" }]);

    const result = await provisionPromptedProject({
      gateway,
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      configPath,
      prompt: async () => "老板指定分组",
    });

    expect(result?.project.id).toBe("existing");
    expect(result?.createdProject).toBe(false);
    expect(gateway.created).toEqual([]);
  });

  it("用户输入不存在的分组名称时只按该名称创建并绑定", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-prompt-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([]);

    const result = await provisionPromptedProject({
      gateway,
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      configPath,
      prompt: async () => "老板指定新分组",
    });

    expect(result?.project.name).toBe("老板指定新分组");
    expect(result?.createdProject).toBe(true);
    expect(gateway.created).toEqual(["老板指定新分组"]);
  });

  it("用户取消分组输入时不创建也不绑定", async () => {
    const gateway = new ProjectGateway([]);

    const result = await provisionPromptedProject({
      gateway,
      cwd: "/workspace/demo",
      prompt: async () => undefined,
    });

    expect(result).toBeUndefined();
    expect(gateway.created).toEqual([]);
  });

  it("识别 dida CLI 未登录错误", () => {
    expect(isDidaAuthenticationError(new Error("未找到 access token。请先运行 `dida auth login` 登录。"))).toBe(true);
    expect(isDidaAuthenticationError(new Error("network failed"))).toBe(false);
  });
});
