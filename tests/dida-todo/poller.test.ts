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
  it("Pi 忙碌或已有待发送消息时保持静默", () => {
    expect(pollDecision({ idle: false, hasPendingMessages: false, remoteWorkIds: ["one"] })).toBe("silent");
    expect(pollDecision({ idle: true, hasPendingMessages: true, remoteWorkIds: ["one"] })).toBe("silent");
  });

  it("仅在空闲且发现有优先级的普通未完成工作时触发 LLM turn", () => {
    expect(pollDecision({ idle: true, hasPendingMessages: false, remoteWorkIds: [] })).toBe("silent");
    expect(pollDecision({ idle: true, hasPendingMessages: false, remoteWorkIds: ["one"] })).toBe("trigger");
  });

  it("无优先级工作不进入轮询选择", () => {
    expect(selectPolledWork([
      work("draft", 0, "2026-08-10T12:00:00Z"),
      work("ready", 1, "2026-08-10T11:00:00Z"),
    ])?.remote.id).toBe("ready");
    expect(selectPolledWork([work("draft", 0, "2026-08-10T12:00:00Z")])).toBeUndefined();
  });

  it("只有待验收任务时保持静默；本人评论已由 Repository 转成普通返工工作", () => {
    expect(pollDecision({ idle: true, hasPendingMessages: false, remoteWorkIds: [], pendingAcceptanceIds: ["accept"] })).toBe("silent");
    expect(pollDecision({ idle: true, hasPendingMessages: false, remoteWorkIds: ["rework"], pendingAcceptanceIds: [] })).toBe("trigger");
  });

  it("自动恢复的 Runtime 绑定不等于 LLM 正在工作，不能阻止轮询", () => {
    expect(pollDecision({ idle: true, hasPendingMessages: false, boundWorkId: "old", remoteWorkIds: ["old", "new"] })).toBe("trigger");
  });

  it("跳过非今天或尚未到开始时间的工作", () => {
    const now = new Date("2026-08-11T08:30:00.000Z");
    const today = work("today", 1, "2026-08-10T10:00:00Z");
    today.remote = { ...today.remote, isAllDay: true, dueDate: "2026-08-11T00:00:00.000+0000", timeZone: "Asia/Shanghai" };
    const tomorrow = work("tomorrow", 5, "2026-08-10T11:00:00Z");
    tomorrow.remote = { ...tomorrow.remote, isAllDay: true, dueDate: "2026-08-11T16:00:00.000+0000", timeZone: "Asia/Shanghai" };
    expect(selectPolledWork([tomorrow, today], now)?.remote.id).toBe("today");
  });

  it("优先选择高优先级工作，同优先级保持滴答清单返回顺序", () => {
    expect(selectPolledWork([
      work("new-low", 1, "2026-08-10T10:00:00Z"),
      work("old-high", 5, "2026-08-10T08:00:00Z"),
      work("new-high", 5, "2026-08-10T11:00:00Z"),
    ])?.remote.id).toBe("old-high");
  });
});
