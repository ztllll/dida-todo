import { describe, expect, it } from "vitest";
import { encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import type { DidaProjectData, DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaTodoRepository, type DidaGateway } from "../../extensions/dida-todo/repository.js";

class SyncGateway implements DidaGateway {
  comments: Array<{ taskId: string; title: string }> = [];
  constructor(public tasks: DidaTask[]) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    return { project: { id: projectId, name: "example" }, tasks: structuredClone(this.tasks.filter((task) => task.status === 0)), columns: [] };
  }
  async getTask(_projectId: string, taskId: string): Promise<DidaTask> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("not found");
    return structuredClone(task);
  }
  async createTask(): Promise<DidaTask> { throw new Error("unused"); }
  async updateTask(taskId: string, input: Record<string, unknown>): Promise<DidaTask> {
    const index = this.tasks.findIndex((candidate) => candidate.id === taskId);
    this.tasks[index] = { ...this.tasks[index], ...structuredClone(input), id: taskId } as DidaTask;
    return structuredClone(this.tasks[index]);
  }
  async completeTask(): Promise<void> { throw new Error("unused"); }
  async addTaskComment(_projectId: string, taskId: string, title: string): Promise<void> {
    this.comments.push({ taskId, title });
  }
  async getTaskComments(_projectId: string, taskId: string): Promise<Array<{ id: string; title: string }>> {
    return this.comments.filter((comment) => comment.taskId === taskId).map((comment, index) => ({ id: `comment-${index + 1}`, title: comment.title }));
  }
}

const scope: TodoScope = {
  binding: { key: "tmux:example:0.0", projectId: "project-1" },
  bindingKey: "tmux:example:0.0",
  cwd: "/workspace/example-project",
  tmuxTarget: "example:0.0",
  sessionId: "session-1",
};

function managedTask(): DidaTask {
  const metadata: WorkMetadata = {
    schemaVersion: 1,
    kind: "pi-todo-work",
    bindingKey: scope.bindingKey,
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

  it("同步待验收任务和用户评论，但不接管成普通工作", async () => {
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
    gateway.comments.push({ taskId: "acceptance", title: "这里还需要优化" });
    const repository = new DidaTodoRepository(gateway);

    const result = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });

    expect(result.adoptedWorkIds).toEqual([]);
    expect(result.works.map((work) => work.remote.id)).toEqual(["managed"]);
    expect(result.acceptances).toHaveLength(1);
    expect(result.acceptances[0]?.comments[0]?.title).toBe("这里还需要优化");
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
