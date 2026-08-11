import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DidaProject } from "../../extensions/dida-todo/domain.js";
import {
  bindExistingProject,
  deriveBindingIdentity,
  ensureProjectBinding,
  isDidaAuthenticationError,
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
  it("优先用 tmux session 名称，否则使用 cwd basename", () => {
    expect(deriveBindingIdentity("/workspace/demo", "my-project:2.1").projectName).toBe("my-project");
    expect(deriveBindingIdentity("/workspace/demo", undefined).projectName).toBe("demo");
  });

  it("没有同名清单时自动创建，并持久化 tmux 与 cwd 双绑定", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([]);

    const result = await ensureProjectBinding({
      gateway,
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      configPath,
    });

    expect(result.createdProject).toBe(true);
    expect(gateway.created).toEqual(["demo"]);
    expect(result.binding.projectId).toBe("project-1");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tmux:demo:0.0", projectId: "project-1" }),
      expect.objectContaining({ key: "cwd:/workspace/demo", projectId: "project-1" }),
    ]));
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("并发首次 provisioning 在同宿主只创建一个清单", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([]);

    const [first, second] = await Promise.all([
      ensureProjectBinding({ gateway, cwd: "/workspace/demo", tmuxTarget: "demo:0.0", configPath }),
      ensureProjectBinding({ gateway, cwd: "/workspace/demo", tmuxTarget: "demo:0.0", configPath }),
    ]);

    expect(gateway.created).toEqual(["demo"]);
    expect([first.binding.projectId, second.binding.projectId]).toEqual(["project-1", "project-1"]);
  });

  it("重复自动初始化保持幂等，不增加绑定或清单", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([]);
    await ensureProjectBinding({ gateway, cwd: "/workspace/demo", tmuxTarget: "demo:0.0", configPath });
    await ensureProjectBinding({ gateway, cwd: "/workspace/demo", tmuxTarget: "demo:0.0", configPath });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(gateway.created).toEqual(["demo"]);
    expect(saved.bindings).toHaveLength(2);
  });

  it("存在唯一同名清单时直接复用，不重复创建", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const gateway = new ProjectGateway([{ id: "existing", name: "demo", closed: false }]);
    const result = await ensureProjectBinding({ gateway, cwd: "/workspace/demo", configPath: join(dir, "config.json") });
    expect(result.binding.projectId).toBe("existing");
    expect(result.createdProject).toBe(false);
    expect(gateway.created).toEqual([]);
  });

  it("同名清单不唯一时拒绝猜测，允许按 ID 显式绑定", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([{ id: "one", name: "demo" }, { id: "two", name: "demo" }]);
    await expect(ensureProjectBinding({ gateway, cwd: "/workspace/demo", configPath })).rejects.toThrow("存在 2 个同名清单");

    const bound = await bindExistingProject({ gateway, cwd: "/workspace/demo", configPath, projectId: "two" });
    expect(bound.binding.projectId).toBe("two");
  });

  it("识别 dida CLI 未登录错误", () => {
    expect(isDidaAuthenticationError(new Error("未找到 access token。请先运行 `dida auth login` 登录。"))).toBe(true);
    expect(isDidaAuthenticationError(new Error("network failed"))).toBe(false);
  });
});
