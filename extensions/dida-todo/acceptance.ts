import type { DidaTask } from "./domain.js";

export interface DidaComment {
  id: string;
  title: string;
  createdTime?: string | number;
}

function utcTimestamp(date: Date): string {
  return date.toISOString().replace("Z", "+0000");
}

export const ACCEPTANCE_REMINDERS = [
  "TRIGGER:PT0S",
  "TRIGGER:PT2M",
  "TRIGGER:PT4M",
  "TRIGGER:PT6M",
  "TRIGGER:PT8M",
] as const;

export function classifyAcceptanceTask(task: DidaTask): boolean {
  return task.tags?.includes("pi-todo-acceptance") === true;
}

export function buildAcceptanceSummary(workTitle: string, tasks: Array<{ subject: string; metadata?: Record<string, unknown> }>): string {
  const lines = tasks.map((task) => {
    const resolution = typeof task.metadata?.resolution === "string" ? task.metadata.resolution : "已完成";
    return `- ${task.subject}：${resolution}`;
  });
  return [`工作「${workTitle}」的全部执行步骤已完成。`, "", ...lines].join("\n");
}

export function buildAcceptanceTaskInput(
  source: DidaTask,
  minutes: number,
  summary: string,
  now = new Date(),
): Record<string, unknown> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("验收提醒时间必须为 1 到 1440 分钟后的整数");
  if (!summary.trim()) throw new Error("验收报告摘要不能为空");
  const date = utcTimestamp(new Date(now.getTime() + minutes * 60_000));
  const content = [
    `Pi 已完成工作任务「${source.title}」，等待人类验收。`,
    "",
    "## 完成报告",
    summary.trim(),
    "",
    "## 人类操作",
    "- 如果验收通过，请在滴答中完成此任务，闭环结束。",
    "- 如果需要调整，请保持任务未完成，并在评论中写明问题或期望；下次 LLM 检查 Todo 时会读取反馈并先向你确认后续处理。",
    "",
    `sourceWorkId: ${source.id}`,
  ].join("\n");
  return {
    projectId: source.projectId,
    title: `🧑‍🔬 待验收：${source.title}`,
    content,
    isAllDay: false,
    startDate: date,
    dueDate: date,
    timeZone: source.timeZone ?? "Asia/Shanghai",
    reminders: [...ACCEPTANCE_REMINDERS],
    priority: source.priority ?? 0,
    items: [],
    tags: ["pi-todo-acceptance"],
  };
}

export function formatAcceptanceForAgent(task: DidaTask, comments: DidaComment[]): string {
  const feedback = comments.length ? comments.map((comment) => `  - ${comment.title}`).join("\n") : "  - 暂无用户评论";
  return [
    `- ${task.title}（等待人类验收，acceptanceId: ${task.id}）`,
    `  ${task.content?.split("\n").find((line) => line.startsWith("sourceWorkId:")) ?? ""}`,
    "  用户反馈：",
    feedback,
    "  该任务未完成只表示尚未闭环，不代表实现失败。若有反馈或长期未验收，应先向用户确认，再决定是否创建返工任务。",
  ].join("\n");
}
