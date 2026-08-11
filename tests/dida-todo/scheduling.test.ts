import { describe, expect, it } from "vitest";
import { buildCompletionReminderInput, formatWorkSchedule, isTaskScheduledForNow, occurrenceKeyForTask } from "../../extensions/dida-todo/scheduling.js";
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

  it("按任务时区只放行今天，跳过明天、后天和过期日期", () => {
    const now = new Date("2026-08-11T08:30:00.000Z"); // Asia/Shanghai 2026-08-11 16:30
    const base = { ...task, isAllDay: true, startDate: undefined };
    expect(isTaskScheduledForNow({ ...base, dueDate: "2026-08-09T16:00:00.000+0000" }, now)).toBe(false);
    expect(isTaskScheduledForNow({ ...base, dueDate: "2026-08-10T16:00:00.000+0000" }, now)).toBe(true);
    expect(isTaskScheduledForNow({ ...base, dueDate: "2026-08-11T16:00:00.000+0000" }, now)).toBe(false);
    expect(isTaskScheduledForNow({ ...base, dueDate: "2026-08-12T16:00:00.000+0000" }, now)).toBe(false);
  });

  it("今天的非全天任务到开始时间才放行，无日期任务保持原行为", () => {
    const now = new Date("2026-08-11T08:30:00.000Z");
    expect(isTaskScheduledForNow({ ...task, startDate: "2026-08-11T08:00:00.000+0000", dueDate: undefined }, now)).toBe(true);
    expect(isTaskScheduledForNow({ ...task, startDate: "2026-08-11T09:00:00.000+0000", dueDate: undefined }, now)).toBe(false);
    expect(isTaskScheduledForNow({ ...task, startDate: undefined, dueDate: undefined }, now)).toBe(true);
  });

  it("重复任务的每次日期生成独立 occurrence key", () => {
    expect(occurrenceKeyForTask({ ...task, repeatFlag: "RRULE:FREQ=DAILY", startDate: "2026-08-11T00:00:00.000+0000" }))
      .toBe("2026-08-11T00:00:00.000+0000");
    expect(occurrenceKeyForTask({ ...task, repeatFlag: "RRULE:FREQ=DAILY", startDate: "2026-08-12T00:00:00.000+0000" }))
      .toBe("2026-08-12T00:00:00.000+0000");
  });
});
