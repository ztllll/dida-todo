import { describe, expect, it } from "vitest";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { formatWorkQueueForAgent, hasUnfinishedTasks, nextUnfinishedWork } from "../../extensions/dida-todo/work-queue.js";

function work(id: string, title: string, statuses: Array<"pending" | "in_progress" | "completed">): WorkTask {
  return {
    remote: { id, projectId: "project", title, status: 0, priority: 0 },
    userContent: "",
    tasks: statuses.map((status, index) => ({ id: index + 1, subject: `${title}-${index + 1}`, status })),
    metadata: {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: "binding",
      nextId: statuses.length + 1,
      tasks: statuses.map((status, index) => ({ id: index + 1, subject: `${title}-${index + 1}`, status })),
    },
  };
}

describe("多工作任务执行队列", () => {
  it("当前工作完成后选择下一个仍有未完成步骤的工作", () => {
    const first = work("first", "最新工作", ["completed"]);
    const second = work("second", "第二工作", ["completed", "pending"]);
    const third = work("third", "第三工作", ["pending"]);

    expect(nextUnfinishedWork([first, second, third], "first")?.remote.id).toBe("second");
    expect(nextUnfinishedWork([first, second, third], "second")?.remote.id).toBe("third");
  });

  it("没有 Checklist 的未完成顶层任务仍是待执行工作", () => {
    const empty = work("empty", "纯标题任务", []);

    expect(hasUnfinishedTasks(empty)).toBe(true);
    expect(nextUnfinishedWork([empty])?.remote.id).toBe("empty");
    expect(formatWorkQueueForAgent([empty])).toContain("[尚无 Checklist，仍需执行]");
    expect(formatWorkQueueForAgent([empty])).toContain("workId: empty");
  });

  it("给 Agent 的同步上下文明确要求连续处理全部未完成工作", () => {
    const text = formatWorkQueueForAgent([
      work("first", "最新工作", ["pending"]),
      work("second", "第二工作", ["completed", "pending"]),
    ]);

    expect(text).toContain("全部未完成顶层工作任务");
    expect(text).toContain("完成一个顶层工作后继续检查并切换到下一个");
    expect(text).toContain("workId: first");
    expect(text).toContain("workId: second");
  });
});
