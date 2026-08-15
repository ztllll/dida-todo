import { describe, expect, it } from "vitest";
import { decodeMetadata, encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import { ACCEPTANCE_COMMENT } from "../../extensions/dida-todo/acceptance.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { MemoryWorkStateStore } from "../../extensions/dida-todo/state-store.js";

class FinishGateway implements DidaGateway {
  created: DidaTask[] = [];
  completed: string[] = [];
  comments: Array<{ taskId: string; title: string }> = [];
  constructor(
    public tasks: DidaTask[],
    private failAcceptance = false,
    private failAcceptanceComment = false,
  ) {}
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
    if (index < 0) throw new Error("not found");
    const current = this.tasks[index]!;
    const items = ((input.items ?? current.items ?? []) as NonNullable<DidaTask["items"]>).map((item, itemIndex) => ({
      ...item,
      id: item.id ?? `item-${itemIndex + 1}`,
    }));
    const updated = { ...current, ...structuredClone(input), id: taskId, items } as DidaTask;
    this.tasks[index] = updated;
    return structuredClone(updated);
  }
  async addTaskComment(_projectId: string, taskId: string, title: string): Promise<void> {
    if (this.failAcceptanceComment && taskId.startsWith("created-")) throw new Error("create acceptance comment failed");
    this.comments.push({ taskId, title });
  }
  async getTaskComments(_projectId: string, taskId: string): Promise<Array<{ id: string; title: string }>> {
    return this.comments.filter((comment) => comment.taskId === taskId).map((comment, index) => ({ id: `comment-${index + 1}`, title: comment.title }));
  }
  async completeTask(_projectId: string, taskId: string): Promise<void> {
    this.completed.push(taskId);
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task) task.status = 2;
  }
}

const scope: TodoScope = {
  binding: { key: "tmux:pi-agent:0.0", projectId: "project" },
  bindingKey: "tmux:pi-agent:0.0",
  cwd: "/workspace/pi-agent",
  tmuxTarget: "pi-agent:0.0",
  sessionId: "session",
};

function completedWork(): DidaTask {
  const metadata: WorkMetadata = {
    schemaVersion: 1,
    kind: "pi-todo-work",
    bindingKey: scope.bindingKey,
    nextId: 3,
    tasks: [
      { id: 1, subject: "实现功能", status: "completed", metadata: { resolution: "实现搜索接口" } },
      { id: 2, subject: "运行测试", status: "completed", metadata: { resolution: "8 项测试通过" } },
    ],
  };
  return {
    id: "work",
    projectId: "project",
    title: "实现搜索",
    content: encodeManagedContent("需求说明", metadata),
    status: 0,
    priority: 5,
    items: [
      { id: "one", title: "实现功能", status: 1 },
      { id: "two", title: "运行测试", status: 1 },
    ],
  };
}

describe("完成工作强制人类验收", () => {
  it("Repository 显式完成最后一个 Checklist 时仍可原子创建验收并完成原任务", async () => {
    const remote = completedWork();
    remote.content = encodeManagedContent("需求说明", {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 3,
      tasks: [
        { id: 1, subject: "实现功能", status: "completed", metadata: { resolution: "实现搜索接口" } },
        { id: 2, subject: "运行测试", status: "pending" },
      ],
    });
    remote.items = [
      { id: "one", title: "实现功能", status: 1 },
      { id: "two", title: "运行测试", status: 0 },
    ];
    const gateway = new FinishGateway([remote]);
    const repository = new DidaTodoRepository(gateway);

    const work = await repository.updateTask(scope, "work", 2, {
      status: "completed",
      metadata: { resolution: "8 项测试通过" },
    });

    expect(work.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(gateway.created).toHaveLength(1);
    expect(gateway.created[0]?.content).toContain("8 项测试通过");
    expect(gateway.completed).toEqual(["work"]);
  });

  it("仍有未完成 Checklist 时不提前创建验收或完成顶层任务", async () => {
    const remote = completedWork();
    remote.content = encodeManagedContent("需求说明", {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 3,
      tasks: [
        { id: 1, subject: "实现功能", status: "pending" },
        { id: 2, subject: "运行测试", status: "pending" },
      ],
    });
    remote.items = [
      { id: "one", title: "实现功能", status: 0 },
      { id: "two", title: "运行测试", status: 0 },
    ];
    const gateway = new FinishGateway([remote]);
    const repository = new DidaTodoRepository(gateway);

    await repository.updateTask(scope, "work", 1, { status: "completed" });

    expect(gateway.created).toHaveLength(0);
    expect(gateway.completed).toEqual([]);
  });

  it("自动收口创建验收失败时 Checklist 保持完成但顶层任务不得完成", async () => {
    const gateway = new FinishGateway([completedWork()], true);
    const repository = new DidaTodoRepository(gateway);

    await expect(repository.updateTask(scope, "work", 2, { status: "completed" })).rejects.toThrow("create acceptance failed");
    expect(gateway.tasks.find((task) => task.id === "work")?.items?.every((item) => item.status === 1)).toBe(true);
    expect(gateway.completed).toEqual([]);
  });

  it("finishWork 自动创建验收 Todo 后才完成原任务", async () => {
    const gateway = new FinishGateway([completedWork()]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.finishWork(scope, "work");

    expect(gateway.created).toHaveLength(1);
    expect(gateway.created[0]).toMatchObject({
      title: "🧑‍🔬 待验收：实现搜索",
      tags: ["pi-todo-acceptance"],
      reminders: ["TRIGGER:PT0S", "TRIGGER:PT3M"],
    });
    expect(gateway.created[0]?.content).toContain("补充内容：\n需求说明");
    expect(gateway.created[0]?.content).toContain("实现搜索接口");
    expect(gateway.created[0]?.content).toContain("8 项测试通过");
    expect(gateway.completed).toEqual(["work"]);
    expect(result.acceptanceTask.id).toBe("created-1");
    expect(gateway.comments).toEqual([{ taskId: "created-1", title: ACCEPTANCE_COMMENT }]);
  });

  it("历史组合描述生成验收时正文只出现一次且不带旧进展块", async () => {
    const remote = completedWork();
    remote.content = "";
    remote.desc = "用户描述\n\n需求说明\n\n当前进展：旧实验状态\n已处理 2/2 项\n\n需求说明\n\n需求说明";
    const metadata: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "ready_for_acceptance",
      workType: "checklist",
      userContent: "需求说明",
      execution: { claimedAt: "2026-08-15T00:00:00.000Z" },
      nextId: 3,
      tasks: [
        { id: 1, subject: "实现功能", status: "completed", itemId: "one", metadata: { resolution: "实现搜索接口" } },
        { id: 2, subject: "运行测试", status: "completed", itemId: "two", metadata: { resolution: "8 项测试通过" } },
      ],
    };
    const stateStore = new MemoryWorkStateStore();
    await stateStore.set(scope.binding.projectId, remote.id, metadata);
    const gateway = new FinishGateway([remote]);
    const repository = new DidaTodoRepository(gateway, stateStore);

    await repository.finishWork(scope, "work");

    const report = String(gateway.created[0]?.desc ?? "");
    expect(report).toContain("任务说明：\n用户描述");
    expect(report).toContain("补充内容：\n需求说明");
    expect(report.split("需求说明")).toHaveLength(2);
    expect(report).not.toContain("当前进展：");
    expect(report).not.toContain("已处理 2/2 项");
  });

  it("按要求保留未勾的 skipped Item 在顶层完成后仍保持未勾", async () => {
    const remote = completedWork();
    const metadata = decodeMetadata(remote.content)!;
    metadata.tasks = [
      { id: 1, subject: "需要勾选", status: "completed", itemId: "item-1" },
      { id: 2, subject: "按要求保留未勾", status: "skipped", itemId: "item-2", metadata: { resolution: "按要求保留未勾" } },
    ];
    metadata.nextId = 3;
    remote.content = encodeManagedContent("需求说明", metadata);
    remote.items = [
      { id: "item-1", title: "需要勾选", status: 1 },
      { id: "item-2", title: "按要求保留未勾", status: 0 },
    ];
    const gateway = new FinishGateway([remote]);
    const repository = new DidaTodoRepository(gateway);

    await repository.finishWork(scope, "work");

    expect(gateway.tasks.find((task) => task.id === "work")?.items).toEqual([
      expect.objectContaining({ title: "需要勾选", status: 1 }),
      expect.objectContaining({ title: "按要求保留未勾", status: 0 }),
    ]);
    expect(gateway.completed).toEqual(["work"]);
  });

  it("完成顶层前强制把远端 Checklist Items 全部标记完成", async () => {
    const remote = completedWork();
    remote.items = [
      { id: "one", title: "实现功能", status: 0 },
      { id: "two", title: "运行测试", status: 0 },
    ];
    const gateway = new FinishGateway([remote]);
    const repository = new DidaTodoRepository(gateway);

    await repository.finishWork(scope, "work");

    const persisted = await gateway.getTask(scope.binding.projectId, "work");
    expect(persisted.items?.map((item) => item.status)).toEqual([1, 1]);
    expect(persisted.status).toBe(2);
  });

  it("已有同源未完成验收 Todo 时复用，不重复创建", async () => {
    const acceptance: DidaTask = {
      id: "acceptance",
      projectId: "project",
      title: "🧑‍🔬 待验收：实现搜索",
      content: "sourceWorkId: work",
      status: 0,
      priority: 5,
      tags: ["pi-todo-acceptance"],
    };
    const gateway = new FinishGateway([completedWork(), acceptance]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.finishWork(scope, "work");

    expect(gateway.created).toHaveLength(0);
    expect(result.acceptanceTask.id).toBe("acceptance");
    expect(gateway.completed).toEqual(["work"]);
    expect(gateway.comments).toEqual([{ taskId: "acceptance", title: ACCEPTANCE_COMMENT }]);
  });

  it("验收已创建但引导评论失败时源任务保持未完成，下次重试复用验收并补评论", async () => {
    const gateway = new FinishGateway([completedWork()], false, true);
    const stateStore = new MemoryWorkStateStore();
    const repository = new DidaTodoRepository(gateway, stateStore);

    await expect(repository.finishWork(scope, "work")).rejects.toThrow("create acceptance comment failed");
    expect(gateway.created).toHaveLength(1);
    expect(gateway.completed).toEqual([]);

    const retryGateway = new FinishGateway(gateway.tasks);
    const retried = await new DidaTodoRepository(retryGateway, stateStore).finishWork(scope, "work");
    expect(retried.acceptanceTask.id).toBe("created-1");
    expect(retryGateway.created).toHaveLength(0);
    expect(retryGateway.comments).toEqual([{ taskId: "created-1", title: ACCEPTANCE_COMMENT }]);
    expect(retryGateway.completed).toEqual(["work"]);
  });

  it("空 Checklist 不得被误判为可完成工作", async () => {
    const remote = completedWork();
    remote.content = encodeManagedContent("需求说明", {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 1,
      tasks: [],
    });
    remote.items = [];
    const gateway = new FinishGateway([remote]);
    const repository = new DidaTodoRepository(gateway);

    await expect(repository.finishWork(scope, "work")).rejects.toThrow("没有可验收的 Checklist");
    expect(gateway.created).toHaveLength(0);
    expect(gateway.completed).toEqual([]);
  });

  it("验收 Todo 创建失败时不得完成原工作", async () => {
    const gateway = new FinishGateway([completedWork()], true);
    const repository = new DidaTodoRepository(gateway);

    await expect(repository.finishWork(scope, "work")).rejects.toThrow("create acceptance failed");
    expect(gateway.completed).toEqual([]);
  });
});
