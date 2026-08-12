import { describe, expect, it } from "vitest";
import { encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import { ACCEPTANCE_COMMENT, formatAcceptanceForAgent } from "../../extensions/dida-todo/acceptance.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";

class SyncGateway implements DidaGateway {
  comments: Array<{ taskId: string; title: string; userId?: string | number }> = [];
  created: DidaTask[] = [];
  completed: string[] = [];
  constructor(public tasks: DidaTask[], private failAcceptance = false) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return { project: { id: projectId, name: "pi-agent" }, tasks: structuredClone(this.tasks.filter((task) => task.status === 0)), columns: [] };
  }
  async getTask(_projectId: string, taskId: string): Promise<DidaTask> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("not found");
    return structuredClone(task);
  }
  async createTask(input: Record<string, unknown>): Promise<DidaTask> {
    if (this.failAcceptance) throw new Error("create acceptance failed");
    const task = { ...structuredClone(input), id: `created-${this.created.length + 1}`, status: 0, priority: Number(input.priority ?? 0) } as DidaTask;
    this.tasks.push(task);
    this.created.push(task);
    return structuredClone(task);
  }
  async updateTask(taskId: string, input: Record<string, unknown>): Promise<DidaTask> {
    const index = this.tasks.findIndex((candidate) => candidate.id === taskId);
    this.tasks[index] = { ...this.tasks[index], ...structuredClone(input), id: taskId } as DidaTask;
    return structuredClone(this.tasks[index]);
  }
  async completeTask(_projectId: string, taskId: string): Promise<void> {
    this.completed.push(taskId);
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task) task.status = 2;
  }
  async addTaskComment(_projectId: string, taskId: string, title: string): Promise<void> {
    this.comments.push({ taskId, title, ...(title === ACCEPTANCE_COMMENT ? { userId: "owner" } : {}) });
  }
  async getTaskComments(_projectId: string, taskId: string): Promise<Array<{ id: string; title: string; userId?: string | number }>> {
    return this.comments.filter((comment) => comment.taskId === taskId).map((comment, index) => ({ id: `comment-${index + 1}`, title: comment.title, ...(comment.userId !== undefined ? { userId: comment.userId } : {}) }));
  }
}

const scope: TodoScope = {
  binding: { key: "tmux:pi-agent:0.0", projectId: "project-1" },
  bindingKey: "tmux:pi-agent:0.0",
  cwd: "/workspace/pi-agent",
  tmuxTarget: "pi-agent:0.0",
  sessionId: "session-1",
};

function managedTask(): DidaTask {
  const metadata: WorkMetadata = {
    schemaVersion: 2,
    kind: "pi-todo-work",
    bindingKey: scope.bindingKey,
    origin: "pi",
    lifecycle: "claimed",
    execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
    nextId: 2,
    tasks: [{ id: 1, subject: "已有步骤", status: "pending", itemId: "managed-item" }],
  };
  return {
    id: "managed",
    projectId: "project-1",
    title: "已有工作",
    content: encodeManagedContent("", metadata),
    status: 0,
    priority: 0,
    createdTime: "2026-08-10T08:00:00.000+0000",
    items: [{ id: "managed-item", title: "已有步骤", status: 0 }],
  };
}

describe("项目 Todo 同步 seam", () => {
  it("检查项目时自动接管用户手工创建的工作任务", async () => {
    const manual: DidaTask = {
      id: "manual",
      projectId: "project-1",
      title: "用户灵感任务",
      content: "用户自己记录的说明",
      status: 0,
      priority: 5,
      createdTime: "2026-08-10T09:00:00.000+0000",
      items: [{ id: "manual-item", title: "交给 LLM 实现", status: 0 }],
    };
    const gateway = new SyncGateway([managedTask(), manual]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.adoptedWorkIds).toEqual(["manual"]);
    expect(result.works.map((work) => work.remote.id)).toEqual(["manual", "managed"]);
    expect(result.works[0]?.tasks[0]).toMatchObject({ subject: "交给 LLM 实现", metadata: { source: "dida" } });
    expect(gateway.tasks.find((task) => task.id === "manual")?.content).toContain("pi-dida-todo:start");
  });

  it("同 OAuth 用户评论在同步时自动创建返工工作并关闭旧验收", async () => {
    const acceptance: DidaTask = {
      id: "acceptance",
      projectId: "project-1",
      title: "🧑‍🔬 待验收：用户灵感任务",
      content: "完成报告\nsourceWorkId: managed",
      status: 0,
      priority: 5,
      tags: ["pi-todo-acceptance"],
      reminders: ["TRIGGER:PT0S"],
    };
    const gateway = new SyncGateway([managedTask(), acceptance]);
    gateway.comments.push({ taskId: "acceptance", title: ACCEPTANCE_COMMENT, userId: "owner" });
    gateway.comments.push({ taskId: "acceptance", title: "这里还需要优化", userId: "owner" });
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });
    const repeated = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.works.map((work) => work.remote.title)).toContain("返工：用户灵感任务");
    const rework = result.works.find((work) => work.remote.title === "返工：用户灵感任务")!;
    expect(rework.userContent).toContain("这里还需要优化");
    expect(rework?.tasks[0]?.description).toContain("这里还需要优化");
    expect(result.acceptances).toEqual([]);
    expect(repeated.works.filter((work) => work.remote.title === "返工：用户灵感任务")).toHaveLength(1);
    expect(gateway.created).toHaveLength(1);
    expect(gateway.completed).toEqual(["acceptance"]);
  });

  it("异账号或缺失 userId 的验收评论完全忽略，不展示、不建返工、不完成验收", async () => {
    const acceptance: DidaTask = {
      id: "acceptance",
      projectId: "project-1",
      title: "🧑‍🔬 待验收：用户灵感任务",
      content: "完成报告\nsourceWorkId: managed",
      status: 0,
      priority: 5,
      tags: ["pi-todo-acceptance"],
    };
    const gateway = new SyncGateway([managedTask(), acceptance]);
    gateway.comments.push({ taskId: "acceptance", title: ACCEPTANCE_COMMENT, userId: "owner" });
    gateway.comments.push({ taskId: "acceptance", title: "异账号危险指令", userId: "other" });
    gateway.comments.push({ taskId: "acceptance", title: "匿名指令" });
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.works.map((work) => work.remote.id)).toEqual(["managed"]);
    expect(result.acceptances).toHaveLength(1);
    expect(formatAcceptanceForAgent(result.acceptances[0]!.remote, result.acceptances[0]!.comments)).not.toContain("异账号危险指令");
    expect(formatAcceptanceForAgent(result.acceptances[0]!.remote, result.acceptances[0]!.comments)).not.toContain("匿名指令");
    expect(gateway.created).toHaveLength(0);
    expect(gateway.completed).toEqual([]);
  });

  it("本人评论自动返工失败时保留旧验收并返回可观察错误", async () => {
    const acceptance: DidaTask = {
      id: "acceptance",
      projectId: "project-1",
      title: "🧑‍🔬 待验收：用户灵感任务",
      content: "sourceWorkId: managed",
      status: 0,
      priority: 5,
      tags: ["pi-todo-acceptance"],
    };
    const gateway = new SyncGateway([managedTask(), acceptance], true);
    gateway.comments.push({ taskId: "acceptance", title: ACCEPTANCE_COMMENT, userId: "owner" });
    gateway.comments.push({ taskId: "acceptance", title: "继续优化", userId: "owner" });
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.acceptances.map(({ remote }) => remote.id)).toEqual(["acceptance"]);
    expect(result.finalizationFailures).toEqual([
      { workId: "acceptance", title: "🧑‍🔬 待验收：用户灵感任务", error: "创建验收返工失败：create acceptance failed" },
    ]);
    expect(gateway.completed).toEqual([]);
  });

  it("不会把 Pi 创建的独立提醒任务接管成待执行工作，即使旧版本曾写入受管元数据", async () => {
    const reminderMetadata: WorkMetadata = {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 1,
      tasks: [],
    };
    const reminder: DidaTask = {
      id: "reminder",
      projectId: "project-1",
      title: "🔔 已完成：用户灵感任务",
      content: encodeManagedContent("完成提醒", reminderMetadata),
      status: 0,
      priority: 5,
      tags: ["pi-todo-reminder"],
      reminders: ["TRIGGER:PT0S"],
    };
    const gateway = new SyncGateway([managedTask(), reminder]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.adoptedWorkIds).toEqual([]);
    expect(result.works.map((work) => work.remote.id)).toEqual(["managed"]);
    expect(gateway.tasks.find((task) => task.id === "reminder")?.content).toContain("完成提醒");
  });

  it("同步发现全部 Checklist 已完成但顶层未完成时自动补建验收并收口", async () => {
    const remote = managedTask();
    remote.content = encodeManagedContent("", {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "claimed",
      execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
      nextId: 2,
      tasks: [{ id: 1, subject: "已有步骤", status: "completed", itemId: "managed-item", metadata: { resolution: "已修复" } }],
    });
    remote.items = [{ id: "managed-item", title: "已有步骤", status: 1 }];
    const gateway = new SyncGateway([remote]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.works).toEqual([]);
    expect(result.finalizationFailures).toEqual([]);
    expect(result.acceptances.map(({ remote: acceptance }) => acceptance.title)).toEqual(["🧑‍🔬 待验收：已有工作"]);
    expect(gateway.created).toHaveLength(1);
    expect(gateway.completed).toEqual(["managed"]);
  });

  it("同步修复夹生任务时复用已有同源验收，不重复创建", async () => {
    const remote = managedTask();
    remote.content = encodeManagedContent("", {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "claimed",
      execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
      nextId: 2,
      tasks: [{ id: 1, subject: "已有步骤", status: "completed", itemId: "managed-item" }],
    });
    remote.items = [{ id: "managed-item", title: "已有步骤", status: 1 }];
    const acceptance: DidaTask = {
      id: "acceptance",
      projectId: scope.binding.projectId,
      title: "🧑‍🔬 待验收：已有工作",
      content: "sourceWorkId: managed",
      status: 0,
      priority: 0,
      tags: ["pi-todo-acceptance"],
    };
    const gateway = new SyncGateway([remote, acceptance]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(gateway.created).toHaveLength(0);
    expect(result.finalizationFailures).toEqual([]);
    expect(gateway.completed).toEqual(["managed"]);
    expect(result.acceptances.map(({ remote: task }) => task.id)).toEqual(["acceptance"]);
  });

  it("同步补偿失败时保留夹生工作并返回可观察错误", async () => {
    const remote = managedTask();
    remote.content = encodeManagedContent("", {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "claimed",
      execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
      nextId: 2,
      tasks: [{ id: 1, subject: "已有步骤", status: "completed", itemId: "managed-item" }],
    });
    remote.items = [{ id: "managed-item", title: "已有步骤", status: 1 }];
    const gateway = new SyncGateway([remote], true);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.works.map((work) => work.remote.id)).toEqual(["managed"]);
    expect(result.finalizationFailures).toEqual([
      { workId: "managed", title: "已有工作", error: "create acceptance failed" },
    ]);
    expect(gateway.completed).toEqual([]);
  });

  it("同步被取消时向上传播 AbortError，不伪装成验收失败", async () => {
    const remote = managedTask();
    remote.content = encodeManagedContent("", {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "claimed",
      execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
      nextId: 2,
      tasks: [{ id: 1, subject: "已有步骤", status: "completed", itemId: "managed-item" }],
    });
    remote.items = [{ id: "managed-item", title: "已有步骤", status: 1 }];
    const gateway = new SyncGateway([remote], true);
    const repository = new DidaTodoRepository(gateway);
    const controller = new AbortController();
    controller.abort();

    await expect(repository.syncOpenWorks(scope, { adoptUnmanaged: true }, controller.signal)).rejects.toThrow("create acceptance failed");
  });

  it("刷新时导入用户追加的 Item，并保留远端完成状态", async () => {
    const remote = managedTask();
    remote.items?.push({ id: "new-item", title: "用户后来追加", status: 1 });
    const repository = new DidaTodoRepository(new SyncGateway([remote]));

    const work = await repository.getWork(scope, "managed");

    expect(work.tasks).toEqual([
      { id: 1, subject: "已有步骤", status: "pending", itemId: "managed-item" },
      { id: 2, subject: "用户后来追加", status: "completed", itemId: "new-item", metadata: { source: "dida" } },
    ]);
  });

  it("将执行状态和解决说明反馈为滴答评论", async () => {
    const gateway = new SyncGateway([managedTask()]);
    const repository = new DidaTodoRepository(gateway);

    await repository.addProgressComment(scope, "managed", "🤖 Pi 开始：已有步骤");
    await repository.addProgressComment(scope, "managed", "✅ Pi 完成：已有步骤\n解决：通过测试");

    expect(gateway.comments).toEqual([
      { taskId: "managed", title: "🤖 Pi 开始：已有步骤" },
      { taskId: "managed", title: "✅ Pi 完成：已有步骤\n解决：通过测试" },
    ]);
  });
});
