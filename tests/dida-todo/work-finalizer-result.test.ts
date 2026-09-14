import { describe, expect, it } from "vitest";
import type { DidaTask, TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";
import { WorkFinalizer } from "../../extensions/dida-todo/work-finalizer.js";

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace",
  sessionId: "session",
};

function allDoneWork(): WorkTask {
  const tasks: WorkTask["tasks"] = [
    { id: 1, subject: "备份数据", status: "completed", itemId: "i1", metadata: { resolution: "备份文件存档于 /tmp/backup.tar.gz" } },
    { id: 2, subject: "执行迁移", status: "skipped", itemId: "i2", metadata: { resolution: "旧库已废弃，无需迁移" } },
    { id: 3, subject: "回归验证", status: "completed", itemId: "i3" },
  ];
  return {
    remote: { id: "work-1", projectId: "project", title: "升级数据库", status: 0, priority: 3 },
    userContent: "",
    tasks,
    metadata: {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "binding",
      origin: "pi",
      lifecycle: "claimed",
      workType: "checklist",
      execution: { claimedAt: "2026-09-10T00:00:00.000Z" },
      nextId: tasks.length + 1,
      tasks,
    },
  };
}

function fakeGateway(work: WorkTask, comments: string[]) {
  const remote = (): DidaTask => ({
    ...work.remote,
    items: work.tasks.map((task) => ({ id: task.itemId, title: task.subject, status: 0 })),
  });
  return {
    async getProjectData() { return { tasks: [] }; },
    async getTask() { return remote(); },
    async updateTask(_taskId: string, input: Record<string, unknown>) { return input as DidaTask; },
    async createTask(input: Record<string, unknown>) { return input as DidaTask; },
    async completeTask(_projectId: string, taskId: string) { comments.push(`completed:${taskId}`); },
    async addTaskComment(_projectId: string, taskId: string, title: string) { comments.push(title); },
    async getTaskComments() { return []; },
  };
}

describe("收口结果汇总评论", () => {
  it("完成工作前把每个步骤的结果汇总成一条评论写回滴答，手机端可直接阅读", async () => {
    const comments: string[] = [];
    const finalizer = new WorkFinalizer(fakeGateway(allDoneWork(), comments) as never);

    await finalizer.finalize(scope, allDoneWork());

    const summary = comments.find((comment) => comment.startsWith("任务完成："));
    expect(summary).toBeDefined();
    expect(summary).toContain("任务完成：升级数据库");
    expect(summary).toContain("- 完成：备份数据 —— 备份文件存档于 /tmp/backup.tar.gz");
    expect(summary).toContain("- 跳过：执行迁移 —— 旧库已废弃，无需迁移");
    expect(summary).toContain("- 完成：回归验证 —— 无备注");
    expect(comments.some((comment) => comment.startsWith("completed:work-1"))).toBe(true);
  });
});
