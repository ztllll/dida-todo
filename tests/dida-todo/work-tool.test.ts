import { describe, expect, it } from "vitest";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { registerTodoWorkTool, selectWorkResult } from "../../extensions/dida-todo/work-tool.js";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { removeSessionRuntime, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
import type { TodoScope } from "../../extensions/dida-todo/domain.js";

function work(id: string, statuses: Array<"pending" | "completed">, priority = 1): WorkTask {
  const tasks = statuses.map((status, index) => ({ id: index + 1, subject: `步骤${index + 1}`, status }));
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority },
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

  it("拒绝用户 priority-0 草稿，但允许恢复 Pi 自建 priority-0 工作", () => {
    expect(() => selectWorkResult([work("draft", [], 0)], "draft")).toThrow("没有设置优先级");
    const piWork = work("pi-work", ["pending"], 0);
    piWork.metadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "binding",
      origin: "pi",
      lifecycle: "claimed",
      execution: { claimedAt: "2026-08-11T00:00:00.000Z" },
      nextId: 2,
      tasks: piWork.tasks,
    };
    expect(selectWorkResult([piWork], "pi-work").remote.id).toBe("pi-work");
  });

  it("拒绝不存在或已有 Checklist 且全部完成的工作", () => {
    expect(() => selectWorkResult([work("one", ["completed"])], "missing")).toThrow("not found");
    expect(() => selectWorkResult([work("one", ["completed"])], "one")).toThrow("没有未完成步骤");
  });

  it("自动收口后 finish_current 在无活动工作时幂等刷新，不报错", async () => {
    const sessionId = "idempotent-finish";
    const scope: TodoScope = {
      binding: { key: "binding", projectId: "project" },
      bindingKey: "binding",
      cwd: "/workspace/demo",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    const repository = {
      async syncOpenWorks() { return { works: [], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerTodoWorkTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    const result = await tool.execute("call", { action: "finish_current" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain("No unfinished Dida work tasks");
    removeSessionRuntime(sessionId);
  });
});
