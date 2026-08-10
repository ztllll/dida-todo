import { describe, expect, it } from "vitest";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import type { DidaProjectData, DidaTask, TodoScope } from "../../extensions/dida-todo/domain.js";

class AdoptionGateway implements DidaGateway {
  constructor(public task: DidaTask) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return { project: { id: projectId, name: "example" }, tasks: [structuredClone(this.task)], columns: [] };
  }
  async getTask(): Promise<DidaTask> { return structuredClone(this.task); }
  async createTask(): Promise<DidaTask> { throw new Error("unused"); }
  async updateTask(_id: string, input: Record<string, unknown>): Promise<DidaTask> {
    this.task = { ...this.task, ...structuredClone(input) } as DidaTask;
    return structuredClone(this.task);
  }
  async completeTask(): Promise<void> { throw new Error("unused"); }
}

const scope: TodoScope = {
  binding: { key: "tmux:example:0.0", projectId: "project-1" },
  bindingKey: "tmux:example:0.0",
  cwd: "/workspace/example-project",
  tmuxTarget: "example:0.0",
  sessionId: "session-1",
};

describe("手工滴答任务接管 seam", () => {
  it("把用户手工创建的 Checklist 工作任务接管为 Pi Todo", async () => {
    const gateway = new AdoptionGateway({
      id: "manual-work",
      projectId: "project-1",
      title: "这是我手打的一个测试",
      content: "人工备注",
      status: 0,
      priority: 0,
      kind: "CHECKLIST",
      items: [
        { id: "i1", title: "继续测试", status: 0 },
        { id: "i2", title: "这是我手动添加的", status: 0 },
      ],
    });
    const repo = new DidaTodoRepository(gateway);

    const work = await repo.adoptWork(scope, "manual-work");
    const reloaded = await repo.getWork(scope, "manual-work");

    expect(work.tasks).toEqual([
      { id: 1, subject: "继续测试", status: "pending", itemId: "i1", metadata: { source: "dida" } },
      { id: 2, subject: "这是我手动添加的", status: "pending", itemId: "i2", metadata: { source: "dida" } },
    ]);
    expect(work.userContent).toBe("人工备注");
    expect(reloaded.tasks).toEqual(work.tasks);
  });
});
