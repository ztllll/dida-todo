import { describe, expect, it } from "bun:test";
import {
  clearPendingAcceptanceResults,
  pendingAcceptanceResults,
  queueAcceptanceResultSource,
  removeSessionRuntime,
  setLatestFinalResponse,
  setSessionRuntime,
} from "../../extensions/dida-todo/runtime.js";
import type { DidaTask, TodoScope } from "../../extensions/dida-todo/domain.js";

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace",
  sessionId: "acceptance-runtime",
};

function source(id: string): DidaTask {
  return { id, projectId: "project", title: id, status: 2, priority: 1 };
}

describe("验收结果会话队列", () => {
  it("去重记录本轮完成源并缓存最终回复", () => {
    setSessionRuntime(scope.sessionId, { scope, works: [] });
    queueAcceptanceResultSource(scope.sessionId, source("one"));
    queueAcceptanceResultSource(scope.sessionId, source("one"));
    queueAcceptanceResultSource(scope.sessionId, source("two"));
    setLatestFinalResponse(scope.sessionId, "最终交付说明");

    expect(pendingAcceptanceResults(scope.sessionId)).toMatchObject({
      sources: [{ id: "one" }, { id: "two" }],
      finalResponse: "最终交付说明",
    });

    clearPendingAcceptanceResults(scope.sessionId);
    expect(pendingAcceptanceResults(scope.sessionId)).toEqual({ sources: [] });
    removeSessionRuntime(scope.sessionId);
  });
});
