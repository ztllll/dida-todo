import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Task, TaskStatus, TodoScope, WorkTask } from "./domain.js";
import { DidaTodoRepository, type CreateTaskInput, type UpdateTaskInput } from "./repository.js";
import { allowedTrackingReasons, getActiveTasks, getSessionRuntime, queueWorkFinalization, resolveWorkFinalization, updateSessionWork } from "./runtime.js";
import { TODO_TRACKING_REASONS, type TodoTrackingReason } from "./tracking-policy.js";

const Params = Type.Object({
  action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
  subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
  trackingReason: Type.Optional(StringEnum(TODO_TRACKING_REASONS, {
    description: "Required for every create. Use current_work_step only for a genuine additional step of the active Dida work; otherwise use one durable top-level tracking reason. Ordinary chat, Q&A, one-off research, read-only inspection, translation, summarization, or merely using multiple tools are not valid reasons.",
  })),
  description: Type.Optional(Type.String({ description: "Long-form task description" })),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while in_progress" })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
  blockedBy: Type.Optional(Type.Array(Type.Number())),
  addBlockedBy: Type.Optional(Type.Array(Type.Number())),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  id: Type.Optional(Type.Number()),
  includeDeleted: Type.Optional(Type.Boolean()),
});

export interface TodoParams {
  action: "create" | "update" | "list" | "get" | "delete" | "clear";
  subject?: string;
  trackingReason?: TodoTrackingReason;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  includeDeleted?: boolean;
}

function requireInitializedRuntime(sessionId: string): { scope: TodoScope; work?: WorkTask; works: WorkTask[] } {
  const runtime = getSessionRuntime(sessionId);
  if (!runtime) throw new Error("当前 Pi 会话尚未初始化滴答 Todo");
  return { scope: runtime.scope, works: runtime.works, ...(runtime.work ? { work: runtime.work } : {}) };
}

function listText(tasks: Task[], status?: TaskStatus, includeDeleted = false): string {
  let visible = includeDeleted ? tasks : tasks.filter((task) => task.status !== "deleted");
  if (status) visible = visible.filter((task) => task.status === status);
  return visible.length
    ? visible
        .map((task) => `[${task.status}] #${task.id} ${task.subject}${task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : ""}`)
        .join("\n")
    : "No tasks";
}

function getText(tasks: Task[], id: number): string {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`#${id} not found`);
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((dep) => `#${dep}`).join(", ")}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  return lines.join("\n");
}

export function registerTodoTool(pi: ExtensionAPI, repository: DidaTodoRepository, onWorkChanged: () => void): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage durable, explicitly tracked Dida work. Do not call for ordinary chat, simple Q&A, one-off research, read-only inspection, translation, rewriting, or summarization. Dida is the source of truth for work that genuinely needs persistent progress.",
    promptSnippet: "Manage only durable Dida-backed work; never use for ordinary chat or one-off queries",
    promptGuidelines: [
      "When the user asks to check todo, inspect the Dida-synchronized work tasks injected into the prompt, choose the relevant unfinished work, and execute it rather than merely listing it.",
      "Use todo only for durable user work that needs persistent progress: the user explicitly requested tracking, a multi-step implementation changes code/config/services, the work must survive across turns/sessions, or background work needs later acceptance. Keep exactly one task in_progress.",
      "Do not use todo for ordinary chat, simple Q&A, one-off web research, read-only inspection, a short command, diagnosis that does not become implementation, translation, rewriting, or summarization. The number of internal tool calls is never by itself a reason to create Todo.",
      "Every todo create requires trackingReason. Starting a top-level work requires one durable reason; current_work_step is valid only for a genuine additional step of the active Dida work. Do not invent a reason to bypass this gate.",
      "Never append unrelated ordinary chat or a separate one-off request to an existing work. If it does not belong to the current durable work, do not call todo.",
      "Mark a task in_progress before beginning it and completed immediately after verified completion.",
      "Do not complete tasks with failing tests or unresolved blockers.",
      "Top-level Dida work selection is handled internally through todo_work; users normally interact through natural language. todo actions operate on Checklist steps, and completing the last step automatically creates human acceptance and completes the source work.",
      "When completing a task, include metadata.resolution with a concise explanation of how it was solved; it is written back to Dida as a task comment.",
      "For user-created Dida works, todo create may append any number of new Checklist steps to the same work. Never rewrite or delete the user's original Checklist text; only advance its execution status and attach metadata.resolution.",
    ],
    parameters: Params,
    async execute(_id, rawParams, signal, _update, ctx) {
      const params = rawParams as TodoParams;
      const sessionId = ctx.sessionManager.getSessionId();
      const initialized = requireInitializedRuntime(sessionId);
      const scope = initialized.scope;
      let work = initialized.work;
      let startedNewWork = false;
      if (params.action === "create") {
        const allowed = allowedTrackingReasons(sessionId);
        if (!params.trackingReason || !allowed.includes(params.trackingReason)) {
          throw new Error(`Todo 创建未获当前用户请求授权：trackingReason=${params.trackingReason ?? "missing"}；允许值=${allowed.join(",") || "none"}`);
        }
      }
      if (!work) {
        const readyText = initialized.works.length
          ? `滴答 Todo 已就绪：已同步 ${initialized.works.length} 个顶层任务，但当前没有已选中的可执行工作。可直接检查 Todo 或创建新 Todo。`
          : "滴答 Todo 已就绪：当前清单为空。可直接创建 Todo，首个步骤会自动建立顶层工作并同步到滴答。";
        if (params.action === "list" || params.action === "clear") {
          return {
            content: [{ type: "text", text: readyText }],
            details: {
              action: params.action,
              params,
              tasks: [],
              nextId: 1,
              ready: true,
              didaProjectId: scope.binding.projectId,
            },
          };
        }
        if (params.action !== "create" || !params.subject) {
          throw new Error(`${readyText} 当前没有可供 ${params.action} 的步骤。`);
        }
        if (!params.trackingReason || params.trackingReason === "current_work_step") {
          throw new Error("trackingReason required：新顶层 Todo 只能使用用户明确追踪、多步骤实施、跨轮恢复或后台验收理由；普通聊天、问答和一次性查询不得创建");
        }
        work = await repository.createWork(scope, params.subject, signal);
        startedNewWork = true;
        updateSessionWork(sessionId, work);
      }
      if (work.remote.status !== 0 && params.action === "create" && params.subject) {
        if (!params.trackingReason || params.trackingReason === "current_work_step") {
          throw new Error("trackingReason required：新顶层 Todo 只用于需要持久追踪的用户工作");
        }
        work = await repository.createWork(scope, params.subject, signal);
        startedNewWork = true;
        updateSessionWork(sessionId, work);
      }
      let nextWork = work;
      let text = "";
      switch (params.action) {
        case "create": {
          if (!params.subject) throw new Error("subject required for create");
          if (!startedNewWork && params.trackingReason !== "current_work_step") {
            throw new Error("trackingReason=current_work_step required：只有确属当前 Dida 工作的后续步骤才能追加");
          }
          const input: CreateTaskInput = {
            subject: params.subject,
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
            ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
            ...(params.owner !== undefined ? { owner: params.owner } : {}),
            ...((params.metadata !== undefined || params.trackingReason !== undefined) ? {
              metadata: {
                ...(params.metadata ?? {}),
                ...(params.trackingReason ? { trackingReason: params.trackingReason } : {}),
              },
            } : {}),
          };
          nextWork = await repository.createTask(scope, work.remote.id, input, signal);
          resolveWorkFinalization(sessionId, work.remote.id);
          const created = nextWork.tasks.at(-1);
          text = `Created #${created?.id}: ${created?.subject} (pending)`;
          break;
        }
        case "update": {
          if (params.id === undefined) throw new Error("id required for update");
          const input: UpdateTaskInput = {
            ...(params.subject !== undefined ? { subject: params.subject } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
            ...(params.status !== undefined ? { status: params.status } : {}),
            ...(params.owner !== undefined ? { owner: params.owner } : {}),
            ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
            ...(params.addBlockedBy !== undefined ? { addBlockedBy: params.addBlockedBy } : {}),
            ...(params.removeBlockedBy !== undefined ? { removeBlockedBy: params.removeBlockedBy } : {}),
          };
          const previous = work.tasks.find((task) => task.id === params.id)?.status;
          nextWork = await repository.updateTask(scope, work.remote.id, params.id, input, signal, { deferFinalization: true });
          const currentTask = nextWork.tasks.find((task) => task.id === params.id);
          const current = currentTask?.status;
          text = `Updated #${params.id}${previous !== current ? ` (${previous} → ${current})` : ""}`;
          if (params.status === "in_progress" && currentTask) {
            await repository.addProgressComment(scope, work.remote.id, `🤖 Pi 开始：${currentTask.subject}`, signal);
          }
          if (params.status === "completed" && currentTask) {
            const resolution = typeof params.metadata?.resolution === "string" ? `\n解决：${params.metadata.resolution}` : "";
            await repository.addProgressComment(scope, work.remote.id, `✅ Pi 完成：${currentTask.subject}${resolution}`, signal);
          }
          break;
        }
        case "delete": {
          if (params.id === undefined) throw new Error("id required for delete");
          nextWork = await repository.updateTask(scope, work.remote.id, params.id, { status: "deleted" }, signal);
          text = `Deleted #${params.id}`;
          break;
        }
        case "list":
          text = listText(work.tasks, params.status, params.includeDeleted);
          break;
        case "get":
          if (params.id === undefined) throw new Error("id required for get");
          text = getText(work.tasks, params.id);
          break;
        case "clear":
          updateSessionWork(sessionId, undefined);
          onWorkChanged();
          return {
            content: [{ type: "text", text: "Detached current Dida work task; remote tasks were not deleted" }],
            details: { action: "clear", tasks: [], nextId: 1 },
          };
      }
      if (nextWork !== work) {
        // Preserve the completed Checklist in the overlay for the rest of this
        // conversation. A later todo create replaces it with the next work.
        updateSessionWork(sessionId, nextWork);
        const visible = nextWork.tasks.filter((task) => task.status !== "deleted");
        if (visible.length > 0 && visible.every((task) => task.status === "completed")) {
          queueWorkFinalization(sessionId, nextWork.remote.id);
        } else {
          resolveWorkFinalization(sessionId, nextWork.remote.id);
        }
        onWorkChanged();
      }
      return {
        content: [{ type: "text", text }],
        details: {
          action: params.action,
          params,
          tasks: nextWork.tasks,
          nextId: nextWork.metadata.nextId,
          didaProjectId: scope.binding.projectId,
          didaWorkTaskId: nextWork.remote.id,
        },
      };
    },
    renderCall(args, theme) {
      const params = args as TodoParams;
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", params.action);
      if (params.subject) text += ` ${theme.fg("dim", params.subject)}`;
      if (params.id !== undefined) {
        const task = getActiveTasks().find((candidate) => candidate.id === params.id);
        text += ` ${theme.fg("accent", task?.subject ?? `#${params.id}`)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, _opts, theme) {
      const details = result.details as { params?: TodoParams; tasks?: Task[] } | undefined;
      const task = details?.tasks?.find((candidate) => candidate.id === details.params?.id) ?? details?.tasks?.at(-1);
      const status = task?.status;
      const glyph = status === "completed" ? "✓" : status === "in_progress" ? "◐" : status === "deleted" ? "⊘" : "○";
      const color = status === "completed" ? "success" : status === "in_progress" ? "warning" : status === "deleted" ? "muted" : "dim";
      return new Text(theme.fg(color, status ? `${glyph} ${status}` : "✓"), 0, 0);
    },
  });
}
