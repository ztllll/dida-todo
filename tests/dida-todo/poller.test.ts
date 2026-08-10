import { describe, expect, it } from "vitest";
import { pollDecision, selectPolledWork } from "../../extensions/dida-todo/poller.js";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";

function work(id: string, priority: number, createdTime: string): WorkTask {
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority, createdTime },
    userContent: "",
    tasks: [{ id: 1, subject: "step", status: "pending" }],
    metadata: { schemaVersion: 1, kind: "pi-todo-work", bindingKey: "binding", nextId: 2, tasks: [{ id: 1, subject: "step", status: "pending" }] },
  };
}

describe("主动 Todo 检查决策", () => {
  it("Pi 忙碌、已有当前工作或已有待发送消息时保持静默", () => {
    expect(pollDecision({ idle: false, hasPendingMessages: false, currentWorkId: undefined, remoteWorkIds: ["one"] })).toBe("silent");
    expect(pollDecision({ idle: true, hasPendingMessages: false, currentWorkId: "one", remoteWorkIds: ["one"] })).toBe("silent");
    expect(pollDecision({ idle: true, hasPendingMessages: true, currentWorkId: undefined, remoteWorkIds: ["one"] })).toBe("silent");
  });

  it("仅在空闲且发现未绑定工作时触发一次 LLM turn", () => {
    expect(pollDecision({ idle: true, hasPendingMessages: false, currentWorkId: undefined, remoteWorkIds: [] })).toBe("silent");
    expect(pollDecision({ idle: true, hasPendingMessages: false, currentWorkId: undefined, remoteWorkIds: ["one"] })).toBe("trigger");
  });

  it("优先选择高优先级工作，同优先级选择最新工作", () => {
    expect(selectPolledWork([
      work("new-low", 1, "2026-08-10T10:00:00Z"),
      work("old-high", 5, "2026-08-10T08:00:00Z"),
      work("new-high", 5, "2026-08-10T11:00:00Z"),
    ])?.remote.id).toBe("new-high");
  });
});
