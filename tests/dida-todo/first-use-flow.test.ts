import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DidaProject, DidaProjectData, DidaTask, DidaTodoConfig, ProjectBinding, TodoScope } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { registerDidaSetupTool } from "../../extensions/dida-todo/setup-tool.js";
import { registerTodoTool } from "../../extensions/dida-todo/tool.js";
import { getSessionRuntime, pendingAcceptanceResults, removeSessionRuntime, setAllowedTrackingReasons, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";

class FirstUseGateway implements DidaGateway {
  projects: DidaProject[] = [];
  tasks: DidaTask[] = [];
  private nextTaskId = 1;

  async login() { return "ok"; }
  async listProjects() { return this.projects; }
  async createProject(name: string) {
    const project = { id: "project", name };
    this.projects.push(project);
    return project;
  }
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return { project: this.projects.find((project) => project.id === projectId)!, tasks: this.tasks.filter((task) => task.projectId === projectId), columns: [] };
  }
  async getTask(_projectId: string, taskId: string) { return structuredClone(this.tasks.find((task) => task.id === taskId)!); }
  async createTask(input: Record<string, unknown>) {
    const task: DidaTask = {
      id: `task-${this.nextTaskId++}`,
      projectId: String(input.projectId),
      title: String(input.title),
      content: String(input.content ?? ""),
      items: structuredClone((input.items ?? []) as DidaTask["items"]),
      tags: structuredClone((input.tags ?? []) as string[]),
      status: 0,
      priority: 0,
    };
    this.tasks.push(task);
    return structuredClone(task);
  }
  async updateTask(taskId: string, input: Record<string, unknown>) {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    const current = this.tasks[index]!;
    const items = ((input.items ?? current.items ?? []) as NonNullable<DidaTask["items"]>).map((item, itemIndex) => ({
      ...item,
      id: item.id ?? `item-${itemIndex + 1}`,
    }));
    const updated: DidaTask = {
      ...current,
      title: String(input.title ?? current.title),
      content: String(input.content ?? current.content ?? ""),
      items,
      tags: structuredClone((input.tags ?? current.tags ?? []) as string[]),
      priority: Number(input.priority ?? current.priority),
    };
    this.tasks[index] = updated;
    return structuredClone(updated);
  }
  async completeTask(_projectId: string, taskId: string) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task) task.status = 2;
  }
  async addTaskComment() {}
  async getTaskComments() { return []; }
}

describe("安装登录后的完整首次使用", () => {
  it("同一会话登录后无需 reload，首个 todo create 立即建立顶层工作和 Checklist", async () => {
    const sessionId = "first-use-session";
    const cwd = "/workspace/demo";
    const tmuxTarget = "demo:0.0";
    const configPath = join(await mkdtemp(join(tmpdir(), "dida-first-use-")), "config.json");
    const config: DidaTodoConfig = { bindings: [] };
    const gateway = new FirstUseGateway();
    const repository = new DidaTodoRepository(gateway);
    let setupTool: any;
    let todoTool: any;
    const pi = {
      registerTool(value: any) {
        if (value.name === "dida_todo_setup") setupTool = value;
        if (value.name === "todo") todoTool = value;
      },
    } as never;
    const activate = async (_ctx: unknown, binding: ProjectBinding) => {
      const scope: TodoScope = { binding, bindingKey: binding.key, cwd, tmuxTarget, sessionId };
      const sync = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });
      setSessionRuntime(sessionId, { scope, works: sync.works });
    };
    registerDidaSetupTool(pi, gateway as never, config, () => ({ cwd, tmuxTarget }), activate, configPath);
    registerTodoTool(pi, repository, () => {});
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };

    const login = await setupTool.execute("login", { action: "login" }, undefined, undefined, ctx);
    setAllowedTrackingReasons(sessionId, ["multi_step_implementation", "current_work_step"]);
    const created = await todoTool.execute("todo", {
      action: "create",
      workTitle: "修复登录流程",
      workType: "checklist",
      subject: "修复登录流程首个阶段",
      trackingReason: "multi_step_implementation",
    }, undefined, undefined, ctx);

    expect(login.details.ready).toBe(true);
    expect(created.content[0].text).toContain("Created #1");
    expect(gateway.projects).toEqual([{ id: "project", name: "demo" }]);
    expect(gateway.tasks).toHaveLength(1);
    expect(gateway.tasks[0]?.title).toBe("修复登录流程");
    expect(gateway.tasks[0]?.items).toEqual([expect.objectContaining({ title: "修复登录流程首个阶段", status: 0 })]);
    removeSessionRuntime(sessionId);
  });

  it("同一 Agent turn 完成唯一步骤后继续 todo create 时追加到原工作，不提前创建验收", async () => {
    const sessionId = "next-work-session";
    const cwd = "/workspace/demo";
    const tmuxTarget = "demo:0.0";
    const configPath = join(await mkdtemp(join(tmpdir(), "dida-next-work-")), "config.json");
    const config: DidaTodoConfig = { bindings: [] };
    const gateway = new FirstUseGateway();
    const repository = new DidaTodoRepository(gateway);
    let setupTool: any;
    let todoTool: any;
    const pi = {
      registerTool(value: any) {
        if (value.name === "dida_todo_setup") setupTool = value;
        if (value.name === "todo") todoTool = value;
      },
    } as never;
    const activate = async (_ctx: unknown, binding: ProjectBinding) => {
      const scope: TodoScope = { binding, bindingKey: binding.key, cwd, tmuxTarget, sessionId };
      const sync = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });
      setSessionRuntime(sessionId, { scope, works: sync.works });
    };
    registerDidaSetupTool(pi, gateway as never, config, () => ({ cwd, tmuxTarget }), activate, configPath);
    registerTodoTool(pi, repository, () => {});
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };

    await setupTool.execute("login", { action: "login" }, undefined, undefined, ctx);
    setAllowedTrackingReasons(sessionId, ["user_requested_tracking", "current_work_step"]);
    await todoTool.execute("create-1", {
      action: "create",
      workTitle: "跨阶段大任务",
      workType: "checklist",
      subject: "第一项工作",
      trackingReason: "user_requested_tracking",
    }, undefined, undefined, ctx);
    await todoTool.execute("complete-1", {
      action: "update",
      id: 1,
      status: "completed",
      metadata: { resolution: "第一项完成" },
    }, undefined, undefined, ctx);
    expect(getSessionRuntime(sessionId)?.work?.tasks[0]?.status).toBe("completed");
    expect(pendingAcceptanceResults(sessionId).sources).toEqual([]);
    const second = await todoTool.execute("create-2", {
      action: "create",
      subject: "第二项工作",
      trackingReason: "current_work_step",
    }, undefined, undefined, ctx);

    expect(second.content[0].text).toContain("Created #2");
    expect(getSessionRuntime(sessionId)?.work?.remote.title).toBe("跨阶段大任务");
    expect(getSessionRuntime(sessionId)?.work?.tasks.map((task) => task.subject)).toEqual(["第一项工作", "第二项工作"]);
    expect(gateway.tasks.filter((task) => task.tags?.includes("pi-todo"))).toHaveLength(1);
    expect(gateway.tasks.some((task) => task.tags?.includes("pi-todo-acceptance"))).toBe(false);
    removeSessionRuntime(sessionId);
  });
});
