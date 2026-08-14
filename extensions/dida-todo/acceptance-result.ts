import type { DidaTask, TodoScope } from "./domain.js";
import { acceptanceMatchesSource } from "./acceptance.js";
import { MemoryWorkStateStore, type WorkStateStore } from "./state-store.js";
import { occurrenceKeyForTask } from "./scheduling.js";

const ACCEPTANCE_TITLE_PREFIX = "🧑‍🔬 待验收：";
const MAX_ACCEPTANCE_TITLE_LENGTH = 100;

type MessageLike = {
  role?: string;
  content?: unknown;
  stopReason?: string;
};

function assistantText(message: MessageLike): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") return undefined;
  if (!Array.isArray(message.content)) return undefined;
  if (message.content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall")) {
    return undefined;
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string"),
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}

export function extractFinalAssistantResponse(messages: readonly MessageLike[]): string | undefined {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return lastAssistant ? assistantText(lastAssistant) : undefined;
}

function resultTitle(sourceTitle: string, finalResponse: string): string {
  const line = finalResponse
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !candidate.startsWith("```") && !/^[-|: ]+$/.test(candidate))
    .map((candidate) => candidate
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/[*_`~]/g, "")
      .trim())
    .find(Boolean);
  const suffix = line || sourceTitle;
  return `${ACCEPTANCE_TITLE_PREFIX}${suffix}`.slice(0, MAX_ACCEPTANCE_TITLE_LENGTH).trimEnd();
}

export interface AcceptanceResultGateway {
  getProjectData(projectId: string, signal?: AbortSignal): Promise<{ tasks: DidaTask[] }>;
  updateTask(taskId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask>;
}

export class AcceptanceResultUpdater {
  constructor(
    private readonly gateway: AcceptanceResultGateway,
    private readonly stateStore: WorkStateStore = new MemoryWorkStateStore(),
  ) {}

  async update(
    scope: TodoScope,
    source: DidaTask,
    finalResponse: string,
    signal?: AbortSignal,
    options: { deriveTitle?: boolean } = {},
  ): Promise<DidaTask | undefined> {
    const data = await this.gateway.getProjectData(scope.binding.projectId, signal);
    const acceptanceId = await this.stateStore.findAcceptance(
      scope.binding.projectId,
      source.id,
      occurrenceKeyForTask(source),
    );
    const acceptance = (acceptanceId ? data.tasks.find((task) => task.id === acceptanceId && task.status === 0) : undefined)
      ?? data.tasks.find((task) => acceptanceMatchesSource(task, source));
    if (!acceptance) return undefined;
    return this.gateway.updateTask(
      acceptance.id,
      buildAcceptanceResultUpdate(source, acceptance, finalResponse, options),
      signal,
    );
  }
}

export function buildAcceptanceResultUpdate(
  source: DidaTask,
  acceptance: DidaTask,
  finalResponse: string,
  options: { deriveTitle?: boolean } = {},
): Record<string, unknown> {
  const result = finalResponse.trim();
  const content = [
    `Pi 已完成工作任务「${source.title}」，等待人类验收。`,
    "",
    "## LLM 最终回复",
    result || `工作「${source.title}」已完成。`,
    "",
    "## 人类操作",
    "- 如果验收通过，请在滴答中完成此任务，闭环结束。",
    "- 如果需要调整，请保持任务未完成，并使用当前滴答 OAuth 账号直接评论；本人评论会自动建立独立返工工作。",
    "- 其他账号或无法确认身份的评论会静默忽略。"
  ].join("\n");
  return {
    id: acceptance.id,
    projectId: acceptance.projectId,
    title: options.deriveTitle === false
      ? `${ACCEPTANCE_TITLE_PREFIX}${source.title}`.slice(0, MAX_ACCEPTANCE_TITLE_LENGTH).trimEnd()
      : resultTitle(source.title, result),
    content,
    desc: result,
    items: acceptance.items ?? [],
    tags: acceptance.tags ?? ["pi-todo-acceptance"],
    priority: acceptance.priority ?? source.priority ?? 0,
    ...(acceptance.isAllDay === true ? { isAllDay: true } : {}),
    ...(acceptance.startDate !== undefined ? { startDate: acceptance.startDate } : {}),
    ...(acceptance.dueDate !== undefined ? { dueDate: acceptance.dueDate } : {}),
    ...(acceptance.timeZone !== undefined ? { timeZone: acceptance.timeZone } : {}),
    ...(acceptance.reminders !== undefined ? { reminders: acceptance.reminders } : {}),
    ...(acceptance.repeatFlag !== undefined ? { repeatFlag: acceptance.repeatFlag } : {}),
    ...(acceptance.sortOrder !== undefined ? { sortOrder: acceptance.sortOrder } : {}),
  };
}
