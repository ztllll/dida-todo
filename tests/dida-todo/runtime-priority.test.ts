import { describe, expect, it } from "vitest";
import type { TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";
import { getSessionRuntime, removeSessionRuntime, setSessionRuntime, updateSessionWorks } from "../../extensions/dida-todo/runtime.js";

function work(id: string, priority: number): WorkTask {
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority },
    tasks: [],
    userContent: "",
    metadata: { schemaVersion: 1, kind: "pi-todo-work", bindingKey: "binding", nextId: 1, tasks: [] },
  };
}

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace",
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
});
