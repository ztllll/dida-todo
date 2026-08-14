import type { DidaTask } from "./domain.js";
import { occurrenceKeyForTask } from "./scheduling.js";

export interface DidaComment {
  id: string;
  title: string;
  userId?: string | number;
  createdTime?: string | number;
}

export const ACCEPTANCE_COMMENT = "💬 验收通过请完成此任务；需要继续处理时，请使用当前滴答 OAuth 账号直接评论。本人评论会自动建立返工工作，其他账号评论静默忽略。";
const LEGACY_ACCEPTANCE_COMMENTS = new Set([
  "💬 请在此处输入验收意见；如果通过，请直接完成此验收任务。",
]);
export const ACCEPTANCE_FEEDBACK_ACK_PREFIX = "🤖 Pi 已读取验收反馈：";
export const ACCEPTANCE_REWORK_COMMENT_PREFIX = "🤖 本人评论自动返工，新工作：";
const LEGACY_ACCEPTANCE_REWORK_COMMENT_PREFIX = "🤖 用户已确认返工，新工作：";

export function acceptanceReworkId(comments: DidaComment[]): string | undefined {
  for (const comment of comments) {
    for (const prefix of [ACCEPTANCE_REWORK_COMMENT_PREFIX, LEGACY_ACCEPTANCE_REWORK_COMMENT_PREFIX]) {
      if (comment.title.startsWith(prefix)) return comment.title.slice(prefix.length);
    }
  }
  return undefined;
}

function utcTimestamp(date: Date): string {
  return date.toISOString().replace("Z", "+0000");
}

// The acceptance task itself is scheduled three minutes after completion.
// These relative triggers therefore notify at completion +3m and +6m.
export const ACCEPTANCE_REMINDERS = ["TRIGGER:PT0S", "TRIGGER:PT3M"] as const;

export function classifyAcceptanceTask(task: DidaTask): boolean {
  return task.tags?.includes("pi-todo-acceptance") === true;
}

export function buildAcceptanceSummary(
  workTitle: string,
  tasks: Array<{ subject: string; metadata?: Record<string, unknown> }>,
  original?: { description?: string; content?: string },
): string {
  const lines = tasks.map((task) => {
    const resolution = typeof task.metadata?.resolution === "string" ? task.metadata.resolution : "已完成";
    return `- ${task.subject}：${resolution}`;
  });
  return [
    `工作「${workTitle}」的全部执行步骤已完成。`,
    ...(original?.description ? ["", `原任务描述：\n${original.description}`] : []),
    ...(original?.content ? ["", `原任务正文：\n${original.content}`] : []),
    "",
    ...lines,
  ].join("\n");
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
    "- 如果需要调整，请保持任务未完成，并使用当前滴答 OAuth 账号在评论中写明任务；系统会自动创建独立返工工作继续处理。",
    "- 其他账号或无法确认身份的评论会静默忽略。"
  ].join("\n");
  return {
    projectId: source.projectId,
    title: `🧑‍🔬 待验收：${source.title}`,
    content,
    desc: summary.trim(),
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

function contentField(content: string | undefined, name: string): string | undefined {
  return content?.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
}

// Compatibility matcher for legacy acceptances that stored source IDs in
// user-visible content. New acceptances are linked by WorkStateStore.
export function acceptanceMatchesSource(task: DidaTask, source: DidaTask): boolean {
  if (!classifyAcceptanceTask(task) || task.status !== 0) return false;
  if (contentField(task.content, "sourceWorkId") !== source.id) return false;
  const occurrence = occurrenceKeyForTask(source);
  return occurrence ? contentField(task.content, "sourceOccurrence") === occurrence : true;
}

function isAcceptancePromptComment(comment: DidaComment): boolean {
  return comment.title === ACCEPTANCE_COMMENT || LEGACY_ACCEPTANCE_COMMENTS.has(comment.title);
}

export function isSystemAcceptanceComment(comment: DidaComment): boolean {
  return isAcceptancePromptComment(comment)
    || comment.title.startsWith(ACCEPTANCE_FEEDBACK_ACK_PREFIX)
    || comment.title.startsWith(ACCEPTANCE_REWORK_COMMENT_PREFIX)
    || comment.title.startsWith(LEGACY_ACCEPTANCE_REWORK_COMMENT_PREFIX);
}

export function authorizedAcceptanceFeedback(comments: DidaComment[]): DidaComment[] {
  const ownerUserId = comments.find(isAcceptancePromptComment)?.userId;
  if (ownerUserId === undefined || ownerUserId === null) return [];
  const acknowledged = new Set(
    comments
      .filter((comment) => comment.title.startsWith(ACCEPTANCE_FEEDBACK_ACK_PREFIX))
      .map((comment) => comment.title.slice(ACCEPTANCE_FEEDBACK_ACK_PREFIX.length)),
  );
  return comments.filter((comment) =>
    !isSystemAcceptanceComment(comment)
    && !acknowledged.has(comment.id)
    && comment.userId !== undefined
    && String(comment.userId) === String(ownerUserId),
  );
}

export function formatAcceptanceForAgent(task: DidaTask, comments: DidaComment[]): string {
  const userComments = authorizedAcceptanceFeedback(comments);
  const feedback = userComments.length
    ? userComments.map((comment) => `  - [commentId: ${comment.id}] ${comment.title}`).join("\n")
    : "  - 暂无用户评论";
  return [
    `- ${task.title}（等待人类验收，acceptanceId: ${task.id}）`,
    "  用户反馈：",
    feedback,
    "  同 OAuth 用户评论会由 Repository 自动转换为独立返工工作；其他账号或缺失 userId 的评论静默忽略，不展示、不执行。已完成源 Checklist 不会回滚。"
  ].join("\n");
}
