import { describe, expect, it } from "vitest";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { registerTodoWorkTool } from "../../extensions/dida-todo/work-tool.js";
import { getSessionRuntime, pendingWorkFinalizations, removeSessionRuntime, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
import { registerTodoTool } from "../../extensions/dida-todo/tool.js";
import type { TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace",
  sessionId: "checklist-finish",
};

function completedChecklist(): WorkTask {
  const tasks = [
    { id: 1, subject: "阶段一", status: "completed" as const },
    { id: 2, subject: "阶段二", status: "completed" as const },
  ];
  return {
    remote: { id: "work", projectId: "project", title: "大型发布任务", status: 0, priority: 1, kind: "CHECKLIST" },
    userContent: "整体目标",
    tasks,
    metadata: {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "binding",
      origin: "pi",
      lifecycle: "claimed",
      workType: "checklist",
      execution: { claimedAt: "2026-08-13T00:00:00.000Z" },
      nextId: 3,
      tasks,
    },
  };
}

describe("Checklist 大任务整体完成", () => {
  it("keepWorkOpen 的 skipped 更新不会排队 settled 收口", async () => {
    const work = completedChecklist();
    work.tasks = [
      { id: 1, subject: "需要勾选", status: "completed" },
      { id: 2, subject: "保持未勾", status: "pending" },
    ];
    work.metadata = { ...work.metadata, origin: "dida", tasks: structuredClone(work.tasks) } as WorkTask["metadata"];
    const keptOpen: WorkTask = {
      ...work,
      tasks: [work.tasks[0]!, { ...work.tasks[1]!, status: "skipped" }],
      metadata: {
        ...work.metadata,
        keepOpen: true,
        tasks: [work.tasks[0]!, { ...work.tasks[1]!, status: "skipped" }],
      } as WorkTask["metadata"],
    };
    setSessionRuntime(scope.sessionId, { scope, works: [work], work });
    let tool: any;
    const repository = {
      async updateTask() { return structuredClone(keptOpen); },
      async addProgressComment() {},
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    await tool.execute("call", {
      action: "update",
      id: 2,
      status: "skipped",
      keepWorkOpen: true,
      metadata: { resolution: "按要求保持未勾" },
    }, undefined, undefined, { sessionManager: { getSessionId: () => scope.sessionId } });

    expect(getSessionRuntime(scope.sessionId)?.work?.metadata).toMatchObject({ keepOpen: true });
    expect(pendingWorkFinalizations(scope.sessionId)).toEqual([]);
    removeSessionRuntime(scope.sessionId);
  });

  it("finish_current 只标记整体完成并排队 settled 收口，不立即创建验收", async () => {
    const work = completedChecklist();
    const ready: WorkTask = {
      ...work,
      metadata: { ...work.metadata, lifecycle: "ready_for_acceptance" } as WorkTask["metadata"],
    };
    setSessionRuntime(scope.sessionId, { scope, works: [work], work });
    let tool: any;
    let finishCalls = 0;
    const repository = {
      async markWorkReadyForAcceptance() { return structuredClone(ready); },
      async finishWork() { finishCalls += 1; return { acceptanceTask: {} }; },
      async syncOpenWorks() { return { works: [ready], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerTodoWorkTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    await tool.execute("call", { action: "finish_current" }, undefined, undefined, {
      sessionManager: { getSessionId: () => scope.sessionId },
    });

    expect(finishCalls).toBe(0);
    expect(getSessionRuntime(scope.sessionId)?.work?.metadata).toMatchObject({ lifecycle: "ready_for_acceptance", workType: "checklist" });
    expect(pendingWorkFinalizations(scope.sessionId)).toEqual(["work"]);
    removeSessionRuntime(scope.sessionId);
  });
});
