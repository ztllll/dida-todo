import type { DidaTask } from "./domain.js";

const PRIORITY_LABELS: Record<number, string> = { 0: "无", 1: "低", 3: "中", 5: "高" };

function utcTimestamp(date: Date): string {
  return date.toISOString().replace("Z", "+0000");
}

export function formatWorkSchedule(task: DidaTask): string {
  const lines = [`优先级: ${PRIORITY_LABELS[task.priority] ?? task.priority}`];
  if (task.startDate) lines.push(`开始: ${task.startDate}`);
  if (task.dueDate) lines.push(`截止: ${task.dueDate}`);
  if (task.timeZone) lines.push(`时区: ${task.timeZone}`);
  if (task.isAllDay !== undefined) lines.push(`全天: ${task.isAllDay ? "是" : "否"}`);
  if (task.reminders?.length) lines.push(`提醒: ${task.reminders.join(", ")}`);
  if (task.repeatFlag) lines.push(`重复: ${task.repeatFlag}`);
  return lines.join("\n");
}

export function buildCompletionReminderInput(task: DidaTask, minutes: number, now = new Date()): Record<string, unknown> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("提醒时间必须为 1 到 1440 分钟后的整数");
  const reminderAt = new Date(now.getTime() + minutes * 60_000);
  const date = utcTimestamp(reminderAt);
  return {
    projectId: task.projectId,
    title: `🔔 已完成：${task.title}`,
    content: `Pi 已完成工作任务「${task.title}」。此提醒由 Pi 在完成后自动创建。`,
    isAllDay: false,
    startDate: date,
    dueDate: date,
    timeZone: task.timeZone ?? "Asia/Shanghai",
    reminders: ["TRIGGER:PT0S"],
    priority: task.priority ?? 0,
    items: [],
    tags: ["pi-todo-reminder"],
  };
}
