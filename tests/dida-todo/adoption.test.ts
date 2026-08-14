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
    this.task.items = (this.task.items ?? []).map((item, index) => ({ ...item, id: item.id ?? `pi-${index + 1}` }));
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

  it("允许向用户手工 Checklist 连续追加 Pi 步骤，且不改写原步骤内容", async () => {
    const gateway = new AdoptionGateway({
      id: "manual-work",
      projectId: "project-1",
      title: "用户任务",
      content: "人工备注",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [{ id: "user-1", title: "用户原始步骤", content: "用户说明", status: 0 }],
    });
    const repo = new DidaTodoRepository(gateway);
    const adopted = await repo.adoptWork(scope, "manual-work");

    const first = await repo.createTask(scope, adopted.remote.id, { subject: "Pi 追加步骤一" });
    const second = await repo.createTask(scope, first.remote.id, { subject: "Pi 追加步骤二" });

    expect(second.tasks.map((task) => task.subject)).toEqual(["用户原始步骤", "Pi 追加步骤一", "Pi 追加步骤二"]);
    expect(second.remote.items?.[0]).toMatchObject({ id: "user-1", title: "用户原始步骤", content: "用户说明" });
    expect(second.tasks.slice(1).every((task) => task.metadata?.source !== "dida")).toBe(true);
  });

  it("手工滴答一级任务产生执行步骤后提升为 Checklist，并保持 TUI 与滴答一致", async () => {
    const gateway = new AdoptionGateway({
      id: "manual-direct",
      projectId: "project-1",
      title: "用户一级任务",
      content: "完整需求正文",
      status: 0,
      priority: 5,
      kind: "TEXT",
    });
    const repo = new DidaTodoRepository(gateway);
    const adopted = await repo.adoptWork(scope, "manual-direct");

    expect(adopted.metadata).toMatchObject({ origin: "dida", workType: "direct" });
    const decomposed = await repo.createTask(scope, adopted.remote.id, {
      subject: "LLM 拆解步骤",
      description: "步骤说明只保存在受管元数据中",
    });

    expect(decomposed.metadata).toMatchObject({ origin: "dida", workType: "checklist" });
    expect(decomposed.remote.items).toEqual([
      expect.objectContaining({ title: "LLM 拆解步骤", status: 0 }),
    ]);
    expect(decomposed.tasks).toEqual([
      expect.objectContaining({ subject: "LLM 拆解步骤", description: "步骤说明只保存在受管元数据中" }),
    ]);
    expect(decomposed.userContent).toBe("完整需求正文");
  });

  it("历史上已拆解为内部步骤的手工 Direct Work 在下一次更新时自动提升", async () => {
    const gateway = new AdoptionGateway({
      id: "legacy-decomposed-direct",
      projectId: "project-1",
      title: "历史一级任务",
      content: "<!-- pi-dida-todo:start -->\n{\"schemaVersion\":2,\"kind\":\"pi-todo-work\",\"bindingKey\":\"tmux:example:0.0\",\"origin\":\"dida\",\"lifecycle\":\"claimed\",\"workType\":\"direct\",\"nextId\":2,\"tasks\":[{\"id\":1,\"subject\":\"已有内部步骤\",\"status\":\"pending\"}]}\n<!-- pi-dida-todo:end -->",
      status: 0,
      priority: 5,
      kind: "TEXT",
    });
    const repo = new DidaTodoRepository(gateway);

    const promoted = await repo.updateTask(scope, "legacy-decomposed-direct", 1, { status: "in_progress" });

    expect(promoted.metadata).toMatchObject({ origin: "dida", workType: "checklist" });
    expect(promoted.remote.items).toEqual([
      expect.objectContaining({ title: "已有内部步骤", status: 0 }),
    ]);
  });

  it("用户原始步骤只能推进状态，不能改名或删除；Pi 追加步骤可编辑", async () => {
    const gateway = new AdoptionGateway({
      id: "manual-work",
      projectId: "project-1",
      title: "用户任务",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [{ id: "user-1", title: "用户原始步骤", status: 0 }],
    });
    const repo = new DidaTodoRepository(gateway);
    const adopted = await repo.adoptWork(scope, "manual-work");
    const appended = await repo.createTask(scope, adopted.remote.id, { subject: "Pi 步骤" });

    await expect(repo.updateTask(scope, appended.remote.id, 1, { subject: "擅自改名" })).rejects.toThrow("用户创建的 Checklist 步骤不允许修改内容");
    await expect(repo.updateTask(scope, appended.remote.id, 1, { status: "deleted" })).rejects.toThrow("用户创建的 Checklist 步骤不允许删除");
    const progressed = await repo.updateTask(scope, appended.remote.id, 1, { status: "in_progress" });
    expect(progressed.tasks[0]).toMatchObject({ subject: "用户原始步骤", status: "in_progress" });
    const editedPiStep = await repo.updateTask(scope, appended.remote.id, 2, { subject: "Pi 步骤（已细化）" });
    expect(editedPiStep.tasks[1]?.subject).toBe("Pi 步骤（已细化）");
  });
});
