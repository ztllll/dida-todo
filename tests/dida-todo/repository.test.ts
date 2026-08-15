import { describe, expect, it } from "vitest";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { encodeManagedContent, metadataToItems, synchronizeItemIds } from "../../extensions/dida-todo/codec.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { MemoryWorkStateStore } from "../../extensions/dida-todo/state-store.js";
import { migrateWorkMetadata } from "../../extensions/dida-todo/work-lifecycle.js";

class FakeGateway implements DidaGateway {
  tasks = new Map<string, DidaTask>();
  nextTask = 1;
  nextItem = 1;

  constructor(private readonly rewriteItemIdsOnUpdate = false) {}

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
      ...(input.desc !== undefined ? { desc: String(input.desc) } : {}),
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
    const task = this.assignItemIds(
      { ...current, ...structuredClone(input), id: taskId } as DidaTask,
      this.rewriteItemIdsOnUpdate,
    );
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

  private assignItemIds(task: DidaTask, rewrite = false): DidaTask {
    task.items = (task.items ?? []).map((item) => ({
      ...item,
      id: rewrite ? `item-${this.nextItem++}` : item.id ?? `item-${this.nextItem++}`,
    }));
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

  it("Checklist 连续 mutation 后描述与正文各只保留一份", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);
    let work = await repo.createWork(scope, "验证描述幂等", undefined, "checklist", "稳定正文", "用户描述", 1);

    work = await repo.createTask(scope, work.remote.id, { subject: "第一步" });
    work = await repo.createTask(scope, work.remote.id, { subject: "第二步" });
    work = await repo.updateTask(scope, work.remote.id, 1, { status: "in_progress" });
    await repo.updateTask(scope, work.remote.id, 1, { status: "completed" });

    const remote = await gateway.getTask(scope.binding.projectId, work.remote.id);
    expect(remote.desc).toBe("用户描述\n\n稳定正文");
    expect(remote.desc?.split("用户描述")).toHaveLength(2);
    expect(remote.desc?.split("稳定正文")).toHaveLength(2);
  });

  it("服务端每次更新都重写 Item ID 时持久化最终一轮 ID", async () => {
    const gateway = new FakeGateway(true);
    const stateStore = new MemoryWorkStateStore();
    gateway.tasks.set("duplicate", {
      id: "duplicate",
      projectId: scope.binding.projectId,
      title: "同名 Checklist",
      content: "",
      desc: "只完成第一项",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [
        { id: "initial-1", title: "二级任务", status: 0 },
        { id: "initial-2", title: "二级任务", status: 0 },
        { id: "initial-3", title: "测试", status: 0 },
        { id: "initial-4", title: "二级任务", status: 0 },
      ],
    });
    const repo = new DidaTodoRepository(gateway, stateStore);
    await repo.syncOpenWorks(scope, { adoptUnmanaged: true });
    const adoptedRemote = await gateway.getTask(scope.binding.projectId, "duplicate");
    const adoptedStored = await stateStore.get(scope.binding.projectId, "duplicate");
    expect(adoptedStored?.tasks.map((task) => task.itemId)).toEqual(adoptedRemote.items?.map((item) => item.id));

    await repo.updateTask(scope, "duplicate", 1, { status: "in_progress" });
    const updated = await repo.updateTask(scope, "duplicate", 1, { status: "completed" });

    const remote = await gateway.getTask(scope.binding.projectId, "duplicate");
    const stored = await stateStore.get(scope.binding.projectId, "duplicate");
    expect(updated.tasks).toHaveLength(4);
    expect(remote.items).toHaveLength(4);
    expect(stored?.tasks.map((task) => task.itemId)).toEqual(remote.items?.map((item) => item.id));
  });

  it("同步时自动净化同名 Item 造成的历史膨胀状态", async () => {
    const gateway = new FakeGateway();
    const stateStore = new MemoryWorkStateStore();
    gateway.tasks.set("poller-test", {
      id: "poller-test",
      projectId: scope.binding.projectId,
      title: "轮询测试",
      content: "",
      desc: "只勾选一个，保持未完成状态",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [
        { id: "new-1", title: "二级任务", status: 1 },
        { id: "new-2", title: "二级任务", status: 0 },
        { id: "new-3", title: "测试", status: 0 },
        { id: "new-4", title: "二级任务", status: 0 },
      ],
    });
    await stateStore.set(scope.binding.projectId, "poller-test", {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      nextId: 7,
      tasks: [
        { id: 1, subject: "二级任务", status: "completed", itemId: "old-1", metadata: { source: "dida" } },
        { id: 2, subject: "二级任务", status: "pending", itemId: "old-2", metadata: { source: "dida" } },
        { id: 3, subject: "测试", status: "pending", itemId: "old-3", metadata: { source: "dida" } },
        { id: 4, subject: "二级任务", status: "pending", itemId: "old-4", metadata: { source: "dida" } },
        { id: 5, subject: "二级任务", status: "pending", itemId: "stale-5", metadata: { source: "dida" } },
        { id: 6, subject: "二级任务", status: "pending", itemId: "stale-6", metadata: { source: "dida" } },
      ],
    });
    const repo = new DidaTodoRepository(gateway, stateStore);

    const result = await repo.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.works[0]?.tasks.map((task) => [task.subject, task.status])).toEqual([
      ["二级任务", "completed"],
      ["二级任务", "pending"],
      ["测试", "pending"],
      ["二级任务", "pending"],
    ]);
    expect((await stateStore.get(scope.binding.projectId, "poller-test"))?.tasks.map((task) => task.itemId)).toEqual([
      "new-1", "new-2", "new-3", "new-4",
    ]);
  });

  it("下一次 mutation 自动净化历史任务里重复追加的正文", async () => {
    const gateway = new FakeGateway();
    const stateStore = new MemoryWorkStateStore();
    const repo = new DidaTodoRepository(gateway, stateStore);
    let work = await repo.createWork(scope, "净化历史描述", undefined, "checklist", "稳定正文", "用户描述", 1);
    work = await repo.createTask(scope, work.remote.id, { subject: "执行净化" });

    const storedMetadata = await stateStore.get(scope.binding.projectId, work.remote.id);
    expect(storedMetadata).toBeDefined();
    const { userDescription: _userDescription, ...legacyMetadata } = migrateWorkMetadata(storedMetadata!);
    await stateStore.set(scope.binding.projectId, work.remote.id, legacyMetadata);
    gateway.tasks.get(work.remote.id)!.desc = "用户描述\n\n稳定正文\n\n当前进展：正在修复状态即时同步\n已处理 1/3 项\n\n稳定正文\n\n稳定正文\n\n稳定正文";

    await repo.updateTask(scope, work.remote.id, 1, { status: "in_progress" });

    const remote = await gateway.getTask(scope.binding.projectId, work.remote.id);
    expect(remote.desc).toBe("用户描述\n\n稳定正文");
    const repairedMetadata = await stateStore.get(scope.binding.projectId, work.remote.id);
    expect(migrateWorkMetadata(repairedMetadata!).userDescription).toBe("用户描述");
  });

  it("用户要求保持顶层未完成时 skipped Item 不触发自动收口", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);
    let work = await repo.createWork(scope, "保留顶层未完成", undefined, "checklist", "", "只勾选一项", 5);
    work = await repo.createTask(scope, work.remote.id, { subject: "需要勾选" });
    work = await repo.createTask(scope, work.remote.id, { subject: "保持未勾" });
    work = await repo.updateTask(scope, work.remote.id, 1, { status: "completed" });

    work = await repo.updateTask(scope, work.remote.id, 2, {
      status: "skipped",
      keepWorkOpen: true,
      metadata: { resolution: "按用户要求保持未勾" },
    });

    expect(work.metadata).toMatchObject({ keepOpen: true, lifecycle: "claimed" });
    const remote = await gateway.getTask(scope.binding.projectId, work.remote.id);
    expect(remote.status).toBe(0);
    expect(remote.items?.map((item) => item.status)).toEqual([1, 0]);
  });

  it("显式整体完成会清除 keepOpen 并恢复正常验收状态", async () => {
    const gateway = new FakeGateway();
    const repo = new DidaTodoRepository(gateway);
    let work = await repo.createWork(scope, "重新允许整体完成", undefined, "checklist", "", "保持开放后再收口", 5);
    work = await repo.createTask(scope, work.remote.id, { subject: "需要勾选" });
    work = await repo.createTask(scope, work.remote.id, { subject: "保持未勾" });
    work = await repo.updateTask(scope, work.remote.id, 1, { status: "completed" });
    work = await repo.updateTask(scope, work.remote.id, 2, { status: "skipped", keepWorkOpen: true });

    work = await repo.markWorkReadyForAcceptance(scope, work.remote.id);

    expect(work.metadata).toMatchObject({ lifecycle: "ready_for_acceptance" });
    expect(work.metadata.schemaVersion === 2 && work.metadata.keepOpen).toBeUndefined();
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
