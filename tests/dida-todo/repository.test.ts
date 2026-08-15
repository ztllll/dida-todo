import { describe, expect, it } from "vitest";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { encodeManagedContent, metadataToItems, synchronizeItemIds } from "../../extensions/dida-todo/codec.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";

class FakeGateway implements DidaGateway {
  tasks = new Map<string, DidaTask>();
  nextTask = 1;
  nextItem = 1;

  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return {
      project: { id: projectId, name: "测试清单", kind: "TASK" },
      tasks: [...this.tasks.values()].filter((task) => task.projectId === projectId && task.status === 0),
      columns: [],
    };
  }

  async getTask(projectId: string, taskId: string): Promise<DidaTask> {
    const task = this.tasks.get(taskId);
    if (!task || task.projectId !== projectId) throw new Error("not found");
    return structuredClone(task);
  }

  async createTask(input: Record<string, unknown>): Promise<DidaTask> {
    const id = `work-${this.nextTask++}`;
    const task = this.assignItemIds({
      id,
      projectId: input.projectId as string,
      title: input.title as string,
      content: input.content as string,
      status: 0,
      priority: Number(input.priority ?? 0),
      kind: "CHECKLIST",
      items: structuredClone(input.items as DidaTask["items"]),
    });
    this.tasks.set(id, task);
    return structuredClone(task);
  }

  async updateTask(taskId: string, input: Record<string, unknown>): Promise<DidaTask> {
    const current = this.tasks.get(taskId);
    if (!current) throw new Error("not found");
    const task = this.assignItemIds({ ...current, ...structuredClone(input), id: taskId } as DidaTask);
    this.tasks.set(taskId, task);
    return structuredClone(task);
  }

  async completeTask(_projectId: string, taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("not found");
    task.status = 2;
  }

  async addTaskComment(): Promise<void> {}
  async getTaskComments(): Promise<Array<{ id: string; title: string }>> { return []; }

  private assignItemIds(task: DidaTask): DidaTask {
    task.items = (task.items ?? []).map((item) => ({ ...item, id: item.id ?? `item-${this.nextItem++}` }));
    return task;
  }
}

const scope: TodoScope = {
  binding: { key: "tmux:example:0.0", projectId: "project-1" },
  bindingKey: "tmux:example:0.0",
  cwd: "/workspace/example-project",
  tmuxTarget: "example:0.0",
  sessionId: "session-1",
};

describe("滴答 Todo Repository seam", () => {
  it("创建 Pi 工作时默认写入可执行低优先级，而不是 priority=0 草稿", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);

    const created = await repo.createWork(scope, "实现联网 Todo");

    expect(created.remote.priority).toBe(1);
    expect((await gateway.getTask(scope.binding.projectId, created.remote.id)).priority).toBe(1);
  });

  it("创建工作任务、添加执行步骤并永久读取", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);

    const created = await repo.createWork(scope, "实现联网 Todo");
    const updated = await repo.createTask(scope, created.remote.id, { subject: "研究现有接口" });
    const reloaded = await repo.getWork(scope, created.remote.id);

    expect(updated.tasks).toEqual([{ id: 1, subject: "研究现有接口", status: "pending", itemId: "item-1" }]);
    expect(reloaded.tasks).toEqual(updated.tasks);
  });

  it("Checklist 已 ready 后追加同一请求的新 Item 会撤销收口状态", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);
    let work = await repo.createWork(scope, "统一用户请求", undefined, "checklist", "", "", 3);
    work = await repo.createTask(scope, work.remote.id, { subject: "第一项" });
    work = await repo.updateTask(scope, work.remote.id, 1, { status: "completed" });
    work = await repo.markWorkReadyForAcceptance(scope, work.remote.id);
    expect(work.metadata).toMatchObject({ lifecycle: "ready_for_acceptance" });

    work = await repo.createTask(scope, work.remote.id, { subject: "第二项" });

    expect(work.metadata).toMatchObject({ lifecycle: "claimed" });
    expect(work.tasks.map((task) => task.subject)).toEqual(["第一项", "第二项"]);
  });

  it("同会话重复 bootstrap 相同标题时复用既有 Pi 工作", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);

    const first = await repo.createWork(scope, "实现联网 Todo");
    const second = await repo.createWork(scope, "实现联网 Todo");

    expect(second.remote.id).toBe(first.remote.id);
    expect(gateway.tasks.size).toBe(1);
  });

  it("将一个步骤标为进行中，再完成步骤和顶层工作", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);
    const work = await repo.createWork(scope, "实现联网 Todo");
    const withTask = await repo.createTask(scope, work.remote.id, { subject: "实现适配器" });

    const active = await repo.updateTask(scope, work.remote.id, 1, {
      status: "in_progress",
      activeForm: "正在实现适配器",
    });
    expect(active.tasks[0]?.status).toBe("in_progress");
    expect(active.metadata.activeTaskId).toBe(1);

    const completed = await repo.updateTask(scope, work.remote.id, 1, { status: "completed" });
    expect(completed.tasks[0]?.status).toBe("completed");
    expect(completed.metadata.activeTaskId).toBeUndefined();

    await repo.markWorkReadyForAcceptance(scope, work.remote.id);
    await repo.finishWork(scope, work.remote.id);
    expect((await gateway.getTask(scope.binding.projectId, work.remote.id)).status).toBe(2);
  });

  it("只恢复当前绑定下未完成的 Pi 工作任务", async () => {
    const gateway = new FakeGateway();
    const good: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "claimed",
      execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
      nextId: 1,
      tasks: [],
    };
    const other = { ...good, bindingKey: "cwd:/other" };
    for (const [id, metadata] of [["good", good], ["other", other]] as const) {
      const remote = await gateway.createTask({
        title: id,
        projectId: scope.binding.projectId,
        content: encodeManagedContent("", metadata),
        items: metadataToItems(metadata),
      });
      const synced = synchronizeItemIds(metadata, remote);
      await gateway.updateTask(remote.id, { ...remote, content: encodeManagedContent("", synced) });
    }

    const repo = new DidaTodoRepository(gateway);
    const works = await repo.listOpenWorks(scope);

    expect(works.map((work) => work.remote.title)).toEqual(["good"]);
  });
});
