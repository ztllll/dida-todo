import { describe, expect, it } from "vitest";
import type { DidaProjectData, DidaTask, TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";
import { queueFingerprint } from "../../extensions/dida-todo/poller.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";
import { MemoryWorkStateStore } from "../../extensions/dida-todo/state-store.js";
import { isExecutableWork } from "../../extensions/dida-todo/work-queue.js";

const scope: TodoScope = {
  binding: { key: "tmux:demo:0.0", projectId: "project" },
  bindingKey: "tmux:demo:0.0",
  cwd: "/workspace/demo",
  sessionId: "session",
};

class Gateway implements DidaGateway {
  readonly created: DidaTask[] = [];
  readonly completed: string[] = [];
  readonly comments: string[] = [];
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
  async addTaskComment(_projectId: string, _taskId: string, title: string): Promise<void> { this.comments.push(title); }
  async getTaskComments(): Promise<Array<{ id: string; title: string }>> { return []; }
}

function blockedWork(): DidaTask {
  return {
    id: "work",
    projectId: "project",
    title: "升级生产数据库",
    status: 0,
    priority: 5,
    kind: "CHECKLIST",
    items: [{ id: "a", title: "确认停机窗口", status: 0 }],
  };
}

async function adopted(gateway: Gateway): Promise<DidaTodoRepository> {
  const repo = new DidaTodoRepository(gateway, new MemoryWorkStateStore());
  await repo.syncOpenWorks(scope, { adoptUnmanaged: true });
  return repo;
}

describe("等待人类：停止轮询刷屏且不完成任务", () => {
  it("挂起后优先级清零、不可执行、创建 +3/+6 分钟提醒，任务保持未完成", async () => {
    const gateway = new Gateway([blockedWork()]);
    const repo = await adopted(gateway);

    const paused = await repo.waitForHuman(scope, "work", "需要你确认今晚的停机窗口");

    expect(gateway.tasks[0]).toMatchObject({ status: 0, priority: 0 });
    expect(isExecutableWork(paused)).toBe(false);
    const reminder = gateway.created.find((task) => task.title.startsWith("🙋"));
    expect(reminder).toMatchObject({ reminders: ["TRIGGER:PT0S", "TRIGGER:PT3M"], tags: ["pi-todo-reminder"], priority: 0 });
    expect(String(reminder?.content)).toContain("需要你确认今晚的停机窗口");
    expect(gateway.comments.some((comment) => comment.includes("等待人工处理"))).toBe(true);
    expect(gateway.completed).toEqual([]);

    const sync = await repo.syncOpenWorks(scope, { adoptUnmanaged: true });
    expect(sync.works.filter(isExecutableWork)).toEqual([]);
  });

  it("用户在滴答把优先级改回后，同步自动恢复并完成提醒", async () => {
    const gateway = new Gateway([blockedWork()]);
    const repo = await adopted(gateway);
    await repo.waitForHuman(scope, "work", "需要你确认今晚的停机窗口");
    const reminderId = gateway.created.find((task) => task.title.startsWith("🙋"))!.id;

    gateway.tasks[0]!.priority = 3;
    const sync = await repo.syncOpenWorks(scope, { adoptUnmanaged: true });

    const work = sync.works.find((candidate) => candidate.remote.id === "work")!;
    expect(isExecutableWork(work)).toBe(true);
    expect(work.metadata).not.toHaveProperty("waitingForHuman");
    expect(gateway.completed).toContain(reminderId);
  });

  it("resume 写回原优先级", async () => {
    const gateway = new Gateway([blockedWork()]);
    const repo = await adopted(gateway);
    await repo.waitForHuman(scope, "work", "需要你确认今晚的停机窗口");

    const resumed = await repo.resumeWork(scope, "work");

    expect(resumed.remote.priority).toBe(5);
    expect(gateway.tasks[0]!.priority).toBe(5);
  });
});

describe("Poller 队列指纹", () => {
  const work = (statuses: string, modifiedTime = "t1"): WorkTask => ({
    remote: { id: "w", projectId: "p", title: "w", status: 0, priority: 3, modifiedTime },
    userContent: "",
    tasks: statuses.split(",").map((status, index) => ({ id: index + 1, subject: `s${index}`, status: status as "pending" })),
    metadata: { schemaVersion: 1, kind: "pi-todo-work", bindingKey: "b", nextId: 3, tasks: [] },
  });

  it("没有任何进展时指纹不变，从而不重复唤醒；有进展或用户编辑时指纹变化", () => {
    expect(queueFingerprint([work("pending,pending")])).toBe(queueFingerprint([work("pending,pending")]));
    expect(queueFingerprint([work("completed,pending")])).not.toBe(queueFingerprint([work("pending,pending")]));
    expect(queueFingerprint([work("pending,pending", "t2")])).not.toBe(queueFingerprint([work("pending,pending")]));
  });
});
