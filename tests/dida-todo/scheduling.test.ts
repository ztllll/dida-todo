import { describe, expect, it } from "vitest";
import { buildCompletionReminderInput, formatWorkSchedule } from "../../extensions/dida-todo/scheduling.js";
import type { DidaTask } from "../../extensions/dida-todo/domain.js";

const task: DidaTask = {
  id: "work",
  projectId: "project",
  title: "高优先级测试",
  status: 0,
  priority: 5,
  startDate: "2026-08-10T10:00:00.000+0000",
  dueDate: "2026-08-10T11:00:00.000+0000",
  timeZone: "Asia/Shanghai",
  isAllDay: false,
  reminders: ["TRIGGER;RELATED=END:-PT15M"],
};

describe("滴答调度字段", () => {
  it("把优先级、时间范围和提醒提供给 Agent", () => {
    const text = formatWorkSchedule(task);
    expect(text).toContain("高");
    expect(text).toContain(task.startDate);
    expect(text).toContain(task.dueDate);
    expect(text).toContain("TRIGGER;RELATED=END:-PT15M");
  });

  it("构造独立的完成提醒任务，避免原任务完成后提醒失效", () => {
    const input = buildCompletionReminderInput(task, 2, new Date("2026-08-10T11:10:00.000Z"));
    expect(input).toMatchObject({
      projectId: "project",
      title: "🔔 已完成：高优先级测试",
      priority: 5,
      startDate: "2026-08-10T11:12:00.000+0000",
      dueDate: "2026-08-10T11:12:00.000+0000",
      timeZone: "Asia/Shanghai",
      isAllDay: false,
      reminders: ["TRIGGER:PT0S"],
      tags: ["pi-todo-reminder"],
    });
    expect(input).not.toHaveProperty("id");
  });

  it("拒绝不合理的提醒分钟数", () => {
    expect(() => buildCompletionReminderInput(task, 0)).toThrow();
    expect(() => buildCompletionReminderInput(task, 1441)).toThrow();
  });
});
