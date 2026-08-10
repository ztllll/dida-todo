import { describe, expect, it } from "vitest";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { selectWorkResult } from "../../extensions/dida-todo/work-tool.js";

function work(id: string, statuses: Array<"pending" | "completed">): WorkTask {
  const tasks = statuses.map((status, index) => ({ id: index + 1, subject: `步骤${index + 1}`, status }));
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority: 0 },
    tasks,
    userContent: "",
    metadata: { schemaVersion: 1, kind: "pi-todo-work", bindingKey: "binding", nextId: tasks.length + 1, tasks },
  };
}

describe("LLM 工作任务切换工具", () => {
  it("选择指定未完成工作，并返回 Checklist", () => {
    const result = selectWorkResult([work("one", ["completed"]), work("two", ["pending"])], "two");
    expect(result.remote.id).toBe("two");
    expect(result.tasks[0]?.status).toBe("pending");
  });

  it("允许选择没有 Checklist 的未完成顶层任务", () => {
    expect(selectWorkResult([work("empty", [])], "empty").remote.id).toBe("empty");
  });

  it("拒绝不存在或已有 Checklist 且全部完成的工作", () => {
    expect(() => selectWorkResult([work("one", ["completed"])], "missing")).toThrow("not found");
    expect(() => selectWorkResult([work("one", ["completed"])], "one")).toThrow("没有未完成步骤");
  });
});
