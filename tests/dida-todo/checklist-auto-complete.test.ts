import { describe, expect, it } from "vitest";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { MemoryWorkStateStore } from "../../extensions/dida-todo/state-store.js";

const scope: TodoScope = {
  binding: { key: "tmux:demo:0.0", projectId: "project" },
  bindingKey: "tmux:demo:0.0",
  cwd: "/workspace/demo",
  sessionId: "session",
};

class Gateway implements DidaGateway {
  readonly created: DidaTask[] = [];
  readonly completed: string[] = [];
  constructor(readonly tasks: DidaTask[]) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return { project: { id: projectId, name: "demo" }, tasks: structuredClone(this.tasks.filter((task) => task.status === 0)), columns: [] };
  }
  async getTask(_projectId: string, taskId: string): Promise<DidaTask> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("not found");
    return structuredClone(task);
  }
  async createTask(input: Record<string, unknown>): Promise<DidaTask> {
    const task = { ...structuredClone(input), id: `created-${this.created.length + 1}`, status: 0 } as DidaTask;
    this.tasks.push(task);
    this.created.push(task);
    return structuredClone(task);
  }
  async updateTask(taskId: string, input: Record<string, unknown>): Promise<DidaTask> {
    const index = this.tasks.findIndex((candidate) => candidate.id === taskId);
    this.tasks[index] = { ...this.tasks[index], ...structuredClone(input), id: taskId } as DidaTask;
    return structuredClone(this.tasks[index]!);
  }
  async completeTask(_projectId: string, taskId: string): Promise<void> {
    this.completed.push(taskId);
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task) task.status = 2;
  }
  async addTaskComment(): Promise<void> {}
  async getTaskComments(): Promise<Array<{ id: string; title: string }>> { return []; }
}

function checklist(overrides: Partial<DidaTask> = {}): DidaTask {
  return {
    id: "work",
    projectId: "project",
    title: "用户大任务",
    status: 0,
    priority: 3,
    kind: "CHECKLIST",
    items: [
      { id: "a", title: "第一步", status: 0 },
      { id: "b", title: "第二步", status: 0 },
    ],
    ...overrides,
  };
}

describe("Checklist 子项全部完成后顶层自动完成", () => {
  it("无优先级时被接管为草稿、之后用户补设优先级：Agent 直接完成全部子项也会收口顶层", async () => {
    const gateway = new Gateway([checklist({ priority: 0 })]);
    const repo = new DidaTodoRepository(gateway, new MemoryWorkStateStore());
    await repo.syncOpenWorks(scope, { adoptUnmanaged: true });
    gateway.tasks[0]!.priority = 3;
    await repo.syncOpenWorks(scope, { adoptUnmanaged: true });

    await repo.updateTask(scope, "work", 1, { status: "completed" });
    await repo.updateTask(scope, "work", 2, { status: "completed" });

    expect(gateway.completed).toContain("work");
  });

  it("循环任务推进到新 occurrence 后，Agent 跳过 in_progress 直接完成全部子项也会收口当期", async () => {
    const stateStore = new MemoryWorkStateStore();
    const stale: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      execution: { occurrence: "2026-10-08T02:00:00.000+0000", claimedAt: "2026-10-08T02:08:00.000Z" },
      nextId: 3,
      tasks: [
        { id: 1, subject: "第一步", itemId: "a", status: "pending", metadata: { source: "dida" } },
        { id: 2, subject: "第二步", itemId: "b", status: "pending", metadata: { source: "dida" } },
      ],
    };
    await stateStore.set("project", "work", stale);
    const gateway = new Gateway([checklist({
      repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
      startDate: "2026-10-10T02:00:00.000+0000",
      dueDate: "2026-10-10T02:00:00.000+0000",
      timeZone: "Asia/Shanghai",
    })]);
    const repo = new DidaTodoRepository(gateway, stateStore);

    await repo.updateTask(scope, "work", 1, { status: "completed" });
    await repo.updateTask(scope, "work", 2, { status: "completed" });

    expect(gateway.completed).toContain("work");
    expect(gateway.created.some((task) => task.tags?.includes("pi-todo-acceptance"))).toBe(true);
  });
});
