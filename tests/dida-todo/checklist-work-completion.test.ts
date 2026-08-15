import { describe, expect, it } from "vitest";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { registerTodoWorkTool } from "../../extensions/dida-todo/work-tool.js";
import { getSessionRuntime, pendingWorkFinalizations, removeSessionRuntime, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
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
