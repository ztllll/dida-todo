import { describe, expect, it } from "bun:test";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { registerDidaTodoWorkTool, selectWorkResult } from "../../extensions/dida-todo/work-tool.js";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { removeSessionRuntime, setQueueCheckPermission, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
import type { TodoScope } from "../../extensions/dida-todo/domain.js";

const TestType = {
  Literal: (_value: string) => undefined,
  Object: () => undefined,
  Optional: <Schema>(schema: Schema) => schema,
  String: () => undefined,
  Union: () => undefined,
};

function work(id: string, statuses: Array<"pending" | "completed">, priority = 1): WorkTask {
  const tasks = statuses.map((status, index) => ({ id: index + 1, subject: `步骤${index + 1}`, status }));
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority },
    tasks,
    userContent: "",
    metadata: { schemaVersion: 3, kind: "dida-todo-work", bindingKey: "binding", origin: "dida", lifecycle: "draft", nextId: tasks.length + 1, tasks },
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

  it.each(["list", "refresh", "next", "switch"] as const)("没有精确‘检查todo’许可时拒绝 %s，且不访问远端", async (action) => {
    const sessionId = `unauthorized-${action}`;
    const scope: TodoScope = {
      binding: { key: "binding", projectId: "project" },
      bindingKey: "binding",
      cwd: "/workspace/demo",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    let syncCalls = 0;
    const repository = {
      async syncOpenWorks() { syncCalls += 1; return { works: [], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerDidaTodoWorkTool({ typebox: { Type: TestType }, registerTool(value: any) { tool = value; } } as never, repository, () => {});

    await expect(tool.execute("call", { action }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    })).rejects.toThrow("只有用户完整输入‘检查todo’");
    expect(syncCalls).toBe(0);
    removeSessionRuntime(sessionId);
  });

  it("list 选择工作时返回标题、描述、正文和 Checklist 的完整任务内容", async () => {
    const sessionId = "complete-work-content";
    const scope: TodoScope = {
      binding: { key: "binding", projectId: "project" },
      bindingKey: "binding",
      cwd: "/workspace/demo",
      sessionId,
    };
    const selected = work("complete", ["pending"]);
    selected.remote.title = "顶层标题";
    selected.remote.desc = "顶层描述";
    selected.userContent = "顶层正文 123321";
    selected.tasks[0]!.description = "步骤说明";
    setSessionRuntime(sessionId, { scope, works: [selected], work: selected });
    setQueueCheckPermission(sessionId, true);
    let tool: any;
    const repository = {
      async syncOpenWorks() { return { works: [selected], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerDidaTodoWorkTool({ typebox: { Type: TestType }, registerTool(value: any) { tool = value; } } as never, repository, () => {});

    const result = await tool.execute("call", { action: "list" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain('"title":"顶层标题"');
    expect(result.content[0].text).toContain('"description":"顶层描述"');
    expect(result.content[0].text).toContain('"content":"顶层正文 123321"');
    expect(result.content[0].text).toContain('"description":"步骤说明"');
    removeSessionRuntime(sessionId);
  });

  it("所有 priority-0 工作都拒绝执行；Pi 历史工作必须先由 Repository 迁移为 low", () => {
    expect(() => selectWorkResult([work("draft", [], 0)], "draft")).toThrow("没有设置优先级");
    const piWork = work("pi-work", ["pending"], 0);
    piWork.metadata = { schemaVersion: 3, kind: "dida-todo-work", bindingKey: "binding", origin: "agent", lifecycle: "claimed",
    execution: { claimedAt: "2026-08-11T00:00:00.000Z" },
    nextId: 2,
    tasks: piWork.tasks, };
    expect(() => selectWorkResult([piWork], "pi-work")).toThrow("没有设置优先级");
  });

  it("拒绝不存在或已有 Checklist 且全部完成的工作", () => {
    expect(() => selectWorkResult([work("one", ["completed"])], "missing")).toThrow("not found");
    expect(() => selectWorkResult([work("one", ["completed"])], "one")).toThrow("没有未完成步骤");
  });

  it("finish_current 未获队列检查授权时只收口当前工作，不自动选择下一项", async () => {
    const sessionId = "finish-without-scan";
    const scope: TodoScope = {
      binding: { key: "binding", projectId: "project" },
      bindingKey: "binding",
      cwd: "/workspace/demo",
      sessionId,
    };
    const current = work("current", ["completed"]);
    const next = work("next", ["pending"]);
    setSessionRuntime(sessionId, { scope, works: [current, next], work: current });
    let tool: any;
    let syncCalls = 0;
    const repository = {
      async markWorkReadyForAcceptance() { return current; },
      async syncOpenWorks() { syncCalls += 1; return { works: [current, next], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerDidaTodoWorkTool({ typebox: { Type: TestType }, registerTool(value: any) { tool = value; } } as never, repository, () => {});

    const result = await tool.execute("call", { action: "finish_current" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.details.selectedWorkId).toBe("current");
    expect(result.content[0].text).toContain("Marked current work ready for acceptance");
    expect(syncCalls).toBe(0);
    removeSessionRuntime(sessionId);
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
    let syncCalls = 0;
    const repository = {
      async syncOpenWorks() { syncCalls += 1; return { works: [], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerDidaTodoWorkTool({ typebox: { Type: TestType }, registerTool(value: any) { tool = value; } } as never, repository, () => {});

    const result = await tool.execute("call", { action: "finish_current" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain("No active current work");
    expect(syncCalls).toBe(0);
    removeSessionRuntime(sessionId);
  });
});
