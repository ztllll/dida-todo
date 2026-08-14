import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { DidaProject } from "../../extensions/dida-todo/domain.js";
import {
  bindExistingProject,
  deriveBindingIdentity,
  ensureProjectBinding,
  isDidaAuthenticationError,
} from "../../extensions/dida-todo/provisioning.js";
import { findImRouteIdentity, namespacedProjectName } from "../../extensions/dida-todo/provisioning-identity.js";

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
  it("按 hostname 与可用 IM route/channel 隔离同名项目", () => {
    const route = findImRouteIdentity({ routes: [{ name: "tmuxbot-admin", channel: "telegram", tmux_target: "tmuxbot-admin:0.0" }] }, "tmuxbot-admin:0.0");
    expect(route).toEqual({ routeName: "tmuxbot-admin", channel: "telegram" });
    expect(namespacedProjectName("tmuxbot-admin", { hostName: "server-a", imRoute: route })).toBe("[server-a][telegram] tmuxbot-admin");
    expect(namespacedProjectName("tmuxbot-admin", { hostName: "server-b", imRoute: route })).toBe("[server-b][telegram] tmuxbot-admin");
    expect(namespacedProjectName("tmuxbot-admin", { hostName: "server-a", imRoute: { routeName: "tmuxbot-admin", channel: "feishu" } })).toBe("[server-a][feishu] tmuxbot-admin");
  });

  it("IM route 不可用时至少使用 hostname + tmux/cwd 名称，不猜通道", () => {
    expect(deriveBindingIdentity("/workspace/demo", "my-project:2.1", { hostName: "server-a" }).projectName).toBe("[server-a] my-project");
    expect(deriveBindingIdentity("/workspace/demo", undefined, { hostName: "server-a" }).projectName).toBe("[server-a] demo");
    expect(findImRouteIdentity({ routes: [
      { name: "one", channel: "telegram", tmux_target: "same:0.0" },
      { name: "two", channel: "feishu", tmux_target: "same:0.0" },
    ] }, "same:0.0")).toBeUndefined();
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
      namespace: { hostName: "server-a", imRoute: { routeName: "demo-route", channel: "telegram" } },
    });

    expect(result.createdProject).toBe(true);
    expect(gateway.created).toEqual(["[server-a][telegram] demo-route"]);
    expect(result.binding.projectId).toBe("project-1");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tmux:demo:0.0", projectId: "project-1" }),
      expect.objectContaining({ key: "cwd:/workspace/demo", projectId: "project-1" }),
    ]));
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("同一 cwd 的不同 tmux/IM route 不互相覆盖精确绑定或 cwd alias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-routes-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([]);

    const telegram = await ensureProjectBinding({
      gateway,
      cwd: "/workspace/shared",
      tmuxTarget: "route-tg:0.0",
      configPath,
      namespace: { hostName: "server-a", imRoute: { routeName: "shared-project", channel: "telegram" } },
    });
    const feishu = await ensureProjectBinding({
      gateway,
      cwd: "/workspace/shared",
      tmuxTarget: "route-fs:0.0",
      configPath,
      namespace: { hostName: "server-a", imRoute: { routeName: "shared-project", channel: "feishu" } },
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(telegram.binding.projectId).not.toBe(feishu.binding.projectId);
    expect(saved.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tmux:route-tg:0.0", projectId: telegram.binding.projectId }),
      expect.objectContaining({ key: "tmux:route-fs:0.0", projectId: feishu.binding.projectId }),
      expect.objectContaining({ key: "cwd:/workspace/shared", projectId: telegram.binding.projectId }),
    ]));
    expect(saved.bindings.filter((entry: { key: string }) => entry.key === "cwd:/workspace/shared")).toHaveLength(1);
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
