import { describe, expect, it } from "vitest";
import { encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { claimCurrentOccurrence } from "../../extensions/dida-todo/work-lifecycle.js";

const scope: TodoScope = {
  binding: { key: "tmux:demo:0.0", projectId: "project" },
  bindingKey: "tmux:demo:0.0",
  cwd: "/workspace/demo",
  tmuxTarget: "demo:0.0",
  sessionId: "session",
};

class LifecycleGateway implements DidaGateway {
  readonly completed: string[] = [];
  readonly created: DidaTask[] = [];

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
    const task = { ...structuredClone(input), id: `acceptance-${this.created.length + 1}`, status: 0, priority: 1 } as DidaTask;
    this.tasks.push(task);
    this.created.push(task);
    return structuredClone(task);
  }

  async updateTask(taskId: string, input: Record<string, unknown>): Promise<DidaTask> {
    const index = this.tasks.findIndex((candidate) => candidate.id === taskId);
    if (index < 0) throw new Error("not found");
    this.tasks[index] = { ...this.tasks[index], ...structuredClone(input), id: taskId } as DidaTask;
    return structuredClone(this.tasks[index]);
  }

  async completeTask(_projectId: string, taskId: string): Promise<void> {
    this.completed.push(taskId);
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task) task.status = 2;
  }

  async addTaskComment(): Promise<void> {}
  async getTaskComments(): Promise<Array<{ id: string; title: string }>> { return []; }
}

function work(metadata: WorkMetadata, overrides: Partial<DidaTask> = {}): DidaTask {
  return {
    id: "work",
    projectId: "project",
    title: "实现功能",
    content: encodeManagedContent("", metadata),
    status: 0,
    priority: 1,
    items: [{ id: "step", title: "实现", status: 1 }],
    ...overrides,
  };
}

describe("WorkLifecycle 发布阻断回归", () => {
  it("priority-0 用户草稿的 Checklist 即使全完成也绝不自动创建验收或完成", async () => {
    const metadata: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "dida",
      lifecycle: "draft",
      nextId: 2,
      tasks: [{ id: 1, subject: "实现", itemId: "step", status: "completed" }],
    };
    const gateway = new LifecycleGateway([work(metadata, { priority: 0 })]);

    await new DidaTodoRepository(gateway).syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(gateway.created).toEqual([]);
    expect(gateway.completed).toEqual([]);
  });

  it("重复任务已推进到下一 occurrence 但 Checklist 尚未重置时不得连跳收口", async () => {
    const metadata: WorkMetadata = {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 2,
      tasks: [{ id: 1, subject: "实现", itemId: "step", status: "completed" }],
    };
    const gateway = new LifecycleGateway([work(metadata, {
      repeatFlag: "RRULE:FREQ=DAILY",
      startDate: "2026-08-12T00:00:00.000+0000",
      timeZone: "Asia/Shanghai",
    })]);

    await new DidaTodoRepository(gateway).syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(gateway.created).toEqual([]);
    expect(gateway.completed).toEqual([]);
  });

  it("重复工作只有当前 occurrence 被 Pi 明确接管后才具备收口资格", () => {
    const metadata: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      origin: "pi",
      lifecycle: "claimed",
      execution: { occurrence: "2026-08-11T00:00:00.000+0000", claimedAt: "2026-08-11T01:00:00.000Z" },
      nextId: 2,
      tasks: [{ id: 1, subject: "实现", itemId: "step", status: "completed" }],
    };
    const advanced = work(metadata, {
      repeatFlag: "RRULE:FREQ=DAILY",
      startDate: "2026-08-12T00:00:00.000+0000",
      timeZone: "Asia/Shanghai",
    });

    const claimed = claimCurrentOccurrence(metadata, advanced, scope);
    expect(claimed.execution?.occurrence).toBe("2026-08-12T00:00:00.000+0000");
    expect(claimed.lifecycle).toBe("claimed");
  });

  it("已完成顶层工作拒绝继续创建 Checklist", async () => {
    const metadata: WorkMetadata = {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 2,
      tasks: [{ id: 1, subject: "实现", itemId: "step", status: "completed" }],
    };
    const gateway = new LifecycleGateway([work(metadata, { status: 2 })]);
    const repository = new DidaTodoRepository(gateway);

    await expect(repository.createTask(scope, "work", { subject: "不应写入" })).rejects.toThrow("已完成");
  });

  it("Item 更新完整保留未知字段、日期与时区", async () => {
    const metadata: WorkMetadata = {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: scope.bindingKey,
      nextId: 2,
      tasks: [{ id: 1, subject: "实现", itemId: "step", status: "pending" }],
    };
    const gateway = new LifecycleGateway([work(metadata, {
      items: [{
        id: "step",
        title: "实现",
        status: 0,
        isAllDay: true,
        startDate: "2026-08-12T00:00:00.000+0000",
        timeZone: "Asia/Shanghai",
        customRemoteField: "must-survive",
      } as NonNullable<DidaTask["items"]>[number]],
    })]);

    await new DidaTodoRepository(gateway).updateTask(scope, "work", 1, { status: "in_progress" });

    expect(gateway.tasks[0]?.items?.[0]).toMatchObject({
      id: "step",
      title: "实现",
      status: 0,
      isAllDay: true,
      startDate: "2026-08-12T00:00:00.000+0000",
      timeZone: "Asia/Shanghai",
      customRemoteField: "must-survive",
    });
  });
});
