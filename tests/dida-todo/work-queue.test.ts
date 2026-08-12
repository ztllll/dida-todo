import { describe, expect, it } from "vitest";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { formatWorkQueueForAgent, hasUnfinishedTasks, isExecutableWork, nextUnfinishedWork } from "../../extensions/dida-todo/work-queue.js";

function work(id: string, title: string, statuses: Array<"pending" | "in_progress" | "completed">, priority = 1): WorkTask {
  return {
    remote: { id, projectId: "project", title, status: 0, priority },
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

  it("没有 Checklist 的直接任务仍是待执行工作，并完整注入标题、描述和正文", () => {
    const empty = work("empty", "直接任务标题", []);
    empty.remote.desc = "直接任务描述";
    empty.userContent = "正文第一行\n正文第二行：123321";

    expect(hasUnfinishedTasks(empty)).toBe(true);
    expect(nextUnfinishedWork([empty])?.remote.id).toBe("empty");
    const text = formatWorkQueueForAgent([empty]);
    expect(text).toContain("[尚无 Checklist，仍需执行]");
    expect(text).toContain('"title":"直接任务标题"');
    expect(text).toContain('"description":"直接任务描述"');
    expect(text).toContain('"content":"正文第一行\\n正文第二行：123321"');
    expect(text).toContain('"checklist":[]');
    expect(text).toContain("必须结合标题、描述和正文理解整体任务");
    expect(text).toContain("workId: empty");
  });

  it("分级任务同时注入顶层内容与 Checklist，而不是只读取子任务标题", () => {
    const hierarchical = work("tree", "分级任务标题", ["pending"]);
    hierarchical.remote.desc = "顶层描述";
    hierarchical.userContent = "顶层正文";
    hierarchical.tasks[0]!.description = "子任务详细说明";

    const text = formatWorkQueueForAgent([hierarchical]);
    expect(text).toContain('"title":"分级任务标题"');
    expect(text).toContain('"description":"顶层描述"');
    expect(text).toContain('"content":"顶层正文"');
    expect(text).toContain('"subject":"分级任务标题-1"');
    expect(text).toContain('"description":"子任务详细说明"');
  });

  it("无优先级任务保留未完成状态，但不进入自动执行队列", () => {
    const draft = work("draft", "持续编辑中的草稿", [], 0);
    const ready = work("ready", "已准备执行", [], 1);

    expect(hasUnfinishedTasks(draft)).toBe(true);
    expect(isExecutableWork(draft)).toBe(false);
    expect(isExecutableWork(ready)).toBe(true);
    expect(nextUnfinishedWork([draft, ready])?.remote.id).toBe("ready");
    const text = formatWorkQueueForAgent([draft, ready]);
    expect(text).not.toContain("workId: draft");
    expect(text).toContain("workId: ready");
  });

  it("按优先级降序排列，同优先级保持输入清单顺序", () => {
    const firstHigh = work("first-high", "先出现高优先级", ["pending"], 5);
    firstHigh.remote.createdTime = "2026-08-10T08:00:00Z";
    const low = work("low", "低优先级", ["pending"], 1);
    const secondHigh = work("second-high", "后出现高优先级", ["pending"], 5);
    secondHigh.remote.createdTime = "2026-08-10T11:00:00Z";

    const text = formatWorkQueueForAgent([low, firstHigh, secondHigh]);
    expect(text.indexOf("workId: first-high")).toBeLessThan(text.indexOf("workId: second-high"));
    expect(text.indexOf("workId: second-high")).toBeLessThan(text.indexOf("workId: low"));
  });

  it("给 Agent 的同步上下文明确要求连续处理全部未完成工作", () => {
    const text = formatWorkQueueForAgent([
      work("first", "最新工作", ["pending"]),
      work("second", "第二工作", ["completed", "pending"]),
    ]);

    expect(text).toContain("全部已设置优先级且未完成的顶层工作任务");
    expect(text).toContain("完成一个顶层工作后继续检查并切换到下一个");
    expect(text).toContain("workId: first");
    expect(text).toContain("workId: second");
  });
});
