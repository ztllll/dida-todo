import { describe, expect, it } from "vitest";
import type { TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";
import { getSessionRuntime, queueWorkFinalization, removeSessionRuntime, setSessionRuntime, updateSessionWorks } from "../../extensions/dida-todo/runtime.js";

function work(id: string, priority: number, piOwned = false): WorkTask {
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority },
    userContent: "",
    tasks: [],
    metadata: piOwned
      ? {
          schemaVersion: 2,
          kind: "pi-todo-work",
          bindingKey: "binding",
          origin: "pi",
          lifecycle: "claimed",
          execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
          nextId: 1,
          tasks: [],
        }
      : { schemaVersion: 1, kind: "pi-todo-work", bindingKey: "binding", nextId: 1, tasks: [] },
  };
}

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace/demo",
  sessionId: "priority-runtime",
};

describe("Runtime 优先级执行门", () => {
  it("刷新后不会把唯一的无优先级草稿绑定为当前工作", () => {
    setSessionRuntime(scope.sessionId, { scope, works: [] });
    updateSessionWorks(scope.sessionId, [work("draft", 0)]);
    expect(getSessionRuntime(scope.sessionId)?.work).toBeUndefined();
    removeSessionRuntime(scope.sessionId);
  });

  it("会自动绑定唯一的有优先级工作", () => {
    setSessionRuntime(scope.sessionId, { scope, works: [] });
    updateSessionWorks(scope.sessionId, [work("draft", 0), work("ready", 1)]);
    expect(getSessionRuntime(scope.sessionId)?.work?.remote.id).toBe("ready");
    removeSessionRuntime(scope.sessionId);
  });

  it("本轮待 settled 收口的全完成工作在刷新后仍保持当前绑定", () => {
    const completed = work("settling", 0, true);
    completed.tasks = [{ id: 1, subject: "阶段结论", status: "completed" }];
    completed.metadata.tasks = completed.tasks;
    completed.metadata.nextId = 2;
    setSessionRuntime(scope.sessionId, { scope, works: [completed], work: completed });
    queueWorkFinalization(scope.sessionId, completed.remote.id);

    updateSessionWorks(scope.sessionId, [completed], completed.remote.id);

    expect(getSessionRuntime(scope.sessionId)?.work?.remote.id).toBe("settling");
    removeSessionRuntime(scope.sessionId);
  });

  it("Pi 自建的 priority-0 工作在 reload 后仍可恢复", () => {
    setSessionRuntime(scope.sessionId, { scope, works: [] });
    updateSessionWorks(scope.sessionId, [work("pi-work", 0, true)]);
    expect(getSessionRuntime(scope.sessionId)?.work?.remote.id).toBe("pi-work");
    removeSessionRuntime(scope.sessionId);
  });
});
