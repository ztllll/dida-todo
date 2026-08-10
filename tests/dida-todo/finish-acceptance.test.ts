import { describe, expect, it } from "vitest";
import { encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";

class FinishGateway implements DidaGateway {
  created: DidaTask[] = [];
  completed: string[] = [];
  constructor(public tasks: DidaTask[], private failAcceptance = false) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return { project: { id: projectId, name: "example" }, tasks: structuredClone(this.tasks.filter((task) => task.status === 0)), columns: [] };
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
  async updateTask(): Promise<DidaTask> { throw new Error("unused"); }
  async completeTask(_projectId: string, taskId: string): Promise<void> {
    this.completed.push(taskId);
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task) task.status = 2;
  }
}

const scope: TodoScope = {
  binding: { key: "tmux:example:0.0", projectId: "project" },
  bindingKey: "tmux:example:0.0",
  cwd: "/workspace/example-project",
  tmuxTarget: "example:0.0",
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
  it("finishWork 自动创建验收 Todo 后才完成原任务", async () => {
    const gateway = new FinishGateway([completedWork()]);
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.finishWork(scope, "work");

    expect(gateway.created).toHaveLength(1);
    expect(gateway.created[0]).toMatchObject({ title: "🧑‍🔬 待验收：实现搜索", tags: ["pi-todo-acceptance"] });
    expect(gateway.created[0]?.content).toContain("实现搜索接口");
    expect(gateway.created[0]?.content).toContain("8 项测试通过");
    expect(gateway.completed).toEqual(["work"]);
    expect(result.acceptanceTask.id).toBe("created-1");
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
  });

  it("验收 Todo 创建失败时不得完成原工作", async () => {
    const gateway = new FinishGateway([completedWork()], true);
    const repository = new DidaTodoRepository(gateway);

    await expect(repository.finishWork(scope, "work")).rejects.toThrow("create acceptance failed");
    expect(gateway.completed).toEqual([]);
  });
});
