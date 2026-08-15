import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { DidaProject } from "../../extensions/dida-todo/domain.js";
import {
  bindExistingProject,
  deriveBindingIdentity,
  ensureProjectBinding,
  ensureExistingBindingAliases,
  isDidaAuthenticationError,
} from "../../extensions/dida-todo/provisioning.js";
import { findImRouteIdentity, topicProjectName } from "../../extensions/dida-todo/provisioning-identity.js";

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
  it("统一使用话题名称，不把 hostname 或 channel 写入清单名", () => {
    const route = findImRouteIdentity({ routes: [{ name: " tmuxbot   admin ", channel: "telegram", tmux_target: "tmuxbot-admin:0.0" }] }, "tmuxbot-admin:0.0");
    expect(route).toEqual({ routeName: "tmuxbot admin", channel: "telegram" });
    expect(topicProjectName("fallback", { hostName: "server-a", imRoute: route })).toBe("tmuxbot admin");
    expect(topicProjectName("fallback", { hostName: "server-b", imRoute: route })).toBe("tmuxbot admin");
    expect(topicProjectName("fallback", { hostName: "server-a", imRoute: { routeName: "tmuxbot admin", channel: "feishu" } })).toBe("tmuxbot admin");
  });

  it("IM route 不可用时优先使用稳定 cwd 名称，不猜通道", () => {
    expect(deriveBindingIdentity("/workspace/demo", "my-project:2.1", { hostName: "server-a" }).projectName).toBe("demo");
    expect(deriveBindingIdentity("/workspace/demo", undefined, { hostName: "server-a" }).projectName).toBe("demo");
    expect(findImRouteIdentity({ routes: [
      { name: "one", channel: "telegram", tmux_target: "same:0.0" },
      { name: "two", channel: "feishu", tmux_target: "same:0.0" },
    ] }, "same:0.0")).toBeUndefined();
  });

  it("没有同话题清单时自动创建，并持久化 topic、tmux 与 cwd 三个别名", async () => {
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
    expect(gateway.created).toEqual(["demo-route"]);
    expect(result.binding).toMatchObject({ key: "topic:demo-route", projectId: "project-1" });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "topic:demo-route", projectId: "project-1" }),
      expect.objectContaining({ key: "tmux:demo:0.0", projectId: "project-1" }),
      expect.objectContaining({ key: "cwd:/workspace/demo", projectId: "project-1" }),
    ]));
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("相同话题名称跨 tmux 和 IM channel 复用同一 projectId", async () => {
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
    expect(gateway.created).toEqual(["shared-project"]);
    expect(telegram.binding.projectId).toBe(feishu.binding.projectId);
    expect(saved.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "topic:shared-project", projectId: telegram.binding.projectId }),
      expect.objectContaining({ key: "tmux:route-tg:0.0", projectId: telegram.binding.projectId }),
      expect.objectContaining({ key: "tmux:route-fs:0.0", projectId: telegram.binding.projectId }),
      expect.objectContaining({ key: "cwd:/workspace/shared", projectId: telegram.binding.projectId }),
    ]));
  });

  it("规范化同话题并发首次 provisioning 只创建一个清单", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([]);

    const [first, second] = await Promise.all([
      ensureProjectBinding({ gateway, cwd: "/workspace/one", tmuxTarget: "one:0.0", configPath, namespace: { imRoute: { routeName: "Demo", channel: "telegram" } } }),
      ensureProjectBinding({ gateway, cwd: "/workspace/two", tmuxTarget: "two:0.0", configPath, namespace: { imRoute: { routeName: " demo ", channel: "feishu" } } }),
    ]);

    expect(gateway.created).toEqual(["Demo"]);
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
    expect(saved.bindings).toHaveLength(3);
  });

  it("规范化话题名称唯一匹配时直接复用，不重复创建", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const gateway = new ProjectGateway([{ id: "existing", name: "  DEMO  ", closed: false }]);
    const result = await ensureProjectBinding({ gateway, cwd: "/workspace/demo", configPath: join(dir, "config.json") });
    expect(result.binding).toMatchObject({ key: "topic:demo", projectId: "existing" });
    expect(result.createdProject).toBe(false);
    expect(gateway.created).toEqual([]);
  });

  it("同名清单不唯一时拒绝猜测，允许按 ID 显式绑定", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-"));
    const configPath = join(dir, "config.json");
    const gateway = new ProjectGateway([{ id: "one", name: "demo" }, { id: "two", name: " DEMO " }]);
    await expect(ensureProjectBinding({ gateway, cwd: "/workspace/demo", configPath })).rejects.toThrow("存在 2 个同名清单");

    const bound = await bindExistingProject({ gateway, cwd: "/workspace/demo", configPath, projectId: "two" });
    expect(bound.binding.projectId).toBe("two");
  });

  it("为历史 tmux/cwd 绑定补充话题别名，不创建或重命名远端清单", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-provision-migrate-"));
    const configPath = join(dir, "config.json");
    await Bun.write(configPath, JSON.stringify({ bindings: [
      { key: "tmux:legacy:0.0", projectId: "legacy-project", cwd: "/workspace/demo", label: "[server][telegram] demo-topic" },
    ] }));

    const result = await ensureExistingBindingAliases({
      binding: { key: "tmux:legacy:0.0", projectId: "legacy-project", cwd: "/workspace/demo" },
      cwd: "/workspace/demo",
      tmuxTarget: "legacy:0.0",
      namespace: { hostName: "server", imRoute: { routeName: "demo-topic", channel: "telegram" } },
      configPath,
    });

    expect(result.binding).toEqual({ key: "topic:demo-topic", projectId: "legacy-project", label: "demo-topic" });
    expect(result.config.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "topic:demo-topic", projectId: "legacy-project" }),
      expect.objectContaining({ key: "tmux:legacy:0.0", projectId: "legacy-project", label: "demo-topic" }),
      expect.objectContaining({ key: "cwd:/workspace/demo", projectId: "legacy-project" }),
    ]));
  });

  it("识别 dida CLI 未登录错误", () => {
    expect(isDidaAuthenticationError(new Error("未找到 access token。请先运行 `dida auth login` 登录。"))).toBe(true);
    expect(isDidaAuthenticationError(new Error("network failed"))).toBe(false);
  });
});
