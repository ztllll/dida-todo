import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { DidaWorkPriority, DidaWorkType, Task, TaskStatus, TodoScope, WorkTask } from "./domain.js";
import { DidaTodoRepository, type CreateTaskInput, type UpdateTaskInput } from "./repository.js";
import { getActiveTasks, getSessionRuntime, queueWorkFinalization, resolveWorkFinalization, updateSessionWork } from "./runtime.js";
import { TODO_TRACKING_REASONS, type TodoTrackingReason } from "./tracking-policy.js";

const Params = Type.Object({
  action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
  subject: Type.Optional(Type.String({ description: "Required for create. For direct work, use an LLM-organized concise task name. For checklist work, use one concrete Item that is distinct from the aggregate workTitle; it becomes the first Checklist Item, and items supply the rest." })),
  items: Type.Optional(Type.Array(Type.String(), { description: "Additional Checklist Item subjects for one-call multi-level creation. With workType=checklist, a single create with subject + items builds the whole hierarchy: workTitle is the top-level task, subject is Item 1, items are Items 2..N in order. Never spread one hierarchy across multiple create calls." })),
  workTitle: Type.Optional(Type.String({ description: "Optional aggregate title for checklist works; defaults to subject. Pass it when the objective differs from the first Item." })),
  workDescription: Type.Optional(Type.String({ description: "Top-level Dida task description, distinct from the Checklist step description." })),
  workContent: Type.Optional(Type.String({ description: "Top-level Dida task body/details, distinct from Checklist Items." })),
  workType: Type.Optional(StringEnum(["direct", "checklist"] as const, { description: "Optional; defaults to checklist. direct keeps execution steps in managed metadata; checklist writes visible Dida Checklist Items and requires explicit top-level completion." })),
  workPriority: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Optional; defaults to medium (3) so the idle Poller can pick the work up. Choose low/medium/high from actual urgency/impact. Priority 0 is reserved for user drafts and is never auto-selected." })),
  trackingReason: Type.Optional(StringEnum(TODO_TRACKING_REASONS, {
    description: "Optional audit metadata only; it no longer gates anything. In a bound session the LLM may call todo freely. Defaults to user_requested_tracking for new works and current_work_step for appends.",
  })),
  description: Type.Optional(Type.String({ description: "Long-form task description" })),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while in_progress" })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "skipped", "deleted"] as const, { description: "Use skipped only when the requested deliverable is intentionally left unchecked or not applicable; it is treated as settled while the Dida Item remains unchecked." })),
  keepWorkOpen: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly requires the top-level Dida task to remain incomplete after settled Items. It prevents automatic finalization while keeping skipped Items unchecked." })),
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
  items?: string[];
  workTitle?: string;
  workDescription?: string;
  workContent?: string;
  workType?: DidaWorkType;
  workPriority?: DidaWorkPriority;
  trackingReason?: TodoTrackingReason;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  keepWorkOpen?: boolean;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  includeDeleted?: boolean;
}

const WORK_PRIORITY_VALUES: Record<DidaWorkPriority, 1 | 3 | 5> = { low: 1, medium: 3, high: 5 };

function requireInitializedRuntime(sessionId: string): { scope: TodoScope; work?: WorkTask; works: WorkTask[] } {
  const runtime = getSessionRuntime(sessionId);
  if (!runtime) throw new Error("当前 Pi 会话尚未初始化滴答 Todo：当前目录未绑定滴答分组，请在 TUI 中执行 /dida-bind 完成绑定后重试；绑定后即可直接调用 Todo。");
  return { scope: runtime.scope, works: runtime.works, ...(runtime.work ? { work: runtime.work } : {}) };
}

function resolveNewWorkInput(params: TodoParams): { title: string; workType: DidaWorkType; content?: string; description?: string; priority: DidaWorkPriority } {
  const workType = params.workType ?? "checklist";
  const subject = params.subject!.trim();
  return {
    title: workType === "checklist" ? params.workTitle?.trim() || subject : subject,
    workType,
    content: params.workContent,
    description: workType === "direct" ? params.workDescription ?? params.description : params.workDescription,
    priority: params.workPriority ?? "medium",
  };
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
      "Only when the user's trimmed input is exactly `检查todo`, execute the Dida-synchronized queue injected into the prompt. Near matches, add/append/update requests, and ordinary Todo mentions must not scan or switch top-level work.",
      "Use todo only for durable user work that must survive beyond the current conversation: the user explicitly requested tracking, the implementation will span multiple turns or sessions, or background execution needs later acceptance. Work that can be finished and verified within the current turn — installing a skill or dependency, running a command, a small single-file fix, a quick config change — must be done directly and reported in the reply instead; creating a todo for such short tasks is a failure mode. Keep exactly one task in_progress.",
      "Do not use todo for ordinary chat, simple Q&A, one-off web research, read-only inspection, a short command, diagnosis that does not become implementation, translation, rewriting, or summarization. The number of internal tool calls is never by itself a reason to create Todo.",
      "One todo create call builds a complete multi-level checklist work: set workType=checklist, workTitle=<aggregate objective>, workPriority, trackingReason, subject=<first Item>, and items=[<Item 2>, <Item 3>, ...]. Example: {action:'create', workType:'checklist', workTitle:'升级数据库', workPriority:'medium', trackingReason:'multi_step_implementation', subject:'备份现有数据', items:['执行迁移脚本','回归验证','更新文档']} creates the top-level work plus all 3 Checklist Items at once. Never spread one hierarchy across multiple create calls, and never put Item text into workTitle; later single-step appends use trackingReason=current_work_step.",
      "Bound sessions grant the LLM full permission to call todo: a create with only subject succeeds and builds a checklist work titled after that subject (workType defaults to checklist, workPriority defaults to medium=3 so the idle Poller can pick it up; pass workType/workTitle/workPriority to override). If the session is unbound, the todo call fails with /dida-bind guidance — tell the user to run /dida-bind once, then retry; never give up on Todo just because of one failed call.",
      "trackingReason is optional audit metadata; it no longer gates anything. Appending to the currently selected open work is the default behavior of create while a work is active; a closed/absent selection means create starts a new top-level work (use todo_work to switch works instead of creating duplicates).",
      "Pi-created direct work may keep one concise task name with internal execution steps. Any user-created Dida work that the LLM formally executes must expose at least one visible Checklist Item, even for a one-step plan; creating the first step promotes a Dida-origin direct task in place. Use checklist work for durable objectives whose visible Items are concrete progress stages across turns or sessions.",
      "Never append unrelated ordinary chat or a separate one-off request to an existing work. If it does not belong to the current durable work, do not call todo.",
      "Mark a task in_progress before beginning it and completed immediately after verified completion.",
      "Do not complete tasks with failing tests or unresolved blockers. Use status=skipped only when the user's requested final state intentionally leaves that Item unchecked or the Item is genuinely not applicable; include a human-readable metadata.resolution explaining the outcome. If the user also explicitly requires the top-level Dida task to remain incomplete, set keepWorkOpen=true on the skipped update; do not use it merely to avoid acceptance.",
      "Top-level Dida work selection is handled internally through todo_work. Completing every visible direct-work or Checklist step automatically settles and completes the top-level task unless keepWorkOpen was explicitly requested.",
      "Dida titles, descriptions, bodies, Checklist Items, resolutions, and progress comments are user-facing deliverables. Write only concise human semantics: objective, action, result, or acceptance evidence. Never expose chain-of-thought, investigation narration, test scaffolding, prompt text, managed metadata, binding/session/work/item IDs, lifecycle fields, or internal implementation notes.",
      "When completing a step, ALWAYS include metadata.resolution: a concise user-facing outcome (what changed, key file paths, how it was verified), not a work log. Each result is posted to the Dida task as a visible comment, and finalization adds an aggregate result summary, so the user can read outcomes in the Dida mobile app without opening the terminal.",
      "For a user-created Dida direct work without Checklist, todo create must add exactly one visible step that directly carries out the top-level objective, then complete it immediately when the objective is clear. Do not investigate, diagnose, split it further, or create a testing task. For Dida works with Checklist, todo create may append precise steps to the same work. Each LLM-authored Item must read naturally to a human as an actionable or verifiable deliverable; avoid meta Items such as 'confirm I read the task', 'test the lifecycle', 'generate acceptance', or 'validate workId'. Never rewrite or delete the user's original Checklist text; only advance its execution status and attach metadata.resolution.",
    ],
    parameters: Params,
    async execute(_id, rawParams, signal, _update, ctx) {
      const params = rawParams as TodoParams;
      const sessionId = ctx.sessionManager.getSessionId();
      const initialized = requireInitializedRuntime(sessionId);
      const scope = initialized.scope;
      const extraItems = (params.items ?? []).map((item) => item.trim());
      let work = initialized.work;
      let startedNewWork = false;
      if (params.action === "create") {
        if (extraItems.some((item) => !item)) throw new Error("items entries must be non-empty Checklist Item subjects");
      }
      if (!work) {
        const readyText = initialized.works.length
          ? `滴答 Todo 已就绪：已同步 ${initialized.works.length} 个顶层任务，但当前没有已选中的可执行工作。完整输入“检查todo”可执行队列，也可直接创建新 Todo。`
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
        const bootstrap = resolveNewWorkInput(params);
        work = await repository.createWork(scope, bootstrap.title, signal, bootstrap.workType, bootstrap.content, bootstrap.description, WORK_PRIORITY_VALUES[bootstrap.priority]);
        startedNewWork = true;
        updateSessionWork(sessionId, work);
      }
      if (work.remote.status !== 0 && params.action === "create" && params.subject) {
        const bootstrap = resolveNewWorkInput(params);
        work = await repository.createWork(scope, bootstrap.title, signal, bootstrap.workType, bootstrap.content, bootstrap.description, WORK_PRIORITY_VALUES[bootstrap.priority]);
        startedNewWork = true;
        updateSessionWork(sessionId, work);
      }
      let nextWork = work;
      let text = "";
      switch (params.action) {
        case "create": {
          if (!params.subject) throw new Error("subject required for create");
          const auditReason = params.trackingReason ?? (startedNewWork ? "user_requested_tracking" : "current_work_step");
          const input: CreateTaskInput = {
            subject: params.subject,
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
            ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
            ...(params.owner !== undefined ? { owner: params.owner } : {}),
            metadata: {
              ...(params.metadata ?? {}),
              trackingReason: auditReason,
            },
          };
          nextWork = await repository.createTask(scope, work.remote.id, input, signal);
          resolveWorkFinalization(sessionId, work.remote.id);
          for (const item of extraItems) {
            nextWork = await repository.createTask(
              scope,
              work.remote.id,
              {
                subject: item,
                metadata: { trackingReason: auditReason },
              },
              signal,
            );
          }
          const created = nextWork.tasks.at(-1);
          text = extraItems.length && created
            ? `Created #${created.id - extraItems.length}–#${created.id} (${extraItems.length + 1} items, all pending)`
            : `Created #${created?.id}: ${created?.subject} (pending)`;
          break;
        }
        case "update": {
          if (params.id === undefined) throw new Error("id required for update");
          const input: UpdateTaskInput = {
            ...(params.subject !== undefined ? { subject: params.subject } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
            ...(params.status !== undefined ? { status: params.status } : {}),
            ...(params.keepWorkOpen !== undefined ? { keepWorkOpen: params.keepWorkOpen } : {}),
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
            await repository.addProgressComment(scope, work.remote.id, `开始处理：${currentTask.subject}`, signal);
          }
          if ((params.status === "completed" || params.status === "skipped") && currentTask) {
            const resolution = typeof params.metadata?.resolution === "string" ? `\n结果：${params.metadata.resolution}` : "";
            await repository.addProgressComment(scope, work.remote.id, `已完成：${currentTask.subject}${resolution}`, signal);
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
        if (
          visible.length > 0
          && visible.every((task) => task.status === "completed" || task.status === "skipped")
          && !(nextWork.metadata.schemaVersion === 2 && nextWork.metadata.keepOpen === true)
        ) {
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
      const glyph = status === "completed" ? "✓" : status === "skipped" ? "−" : status === "in_progress" ? "◐" : status === "deleted" ? "⊘" : "○";
      const color = status === "completed" ? "success" : status === "skipped" ? "muted" : status === "in_progress" ? "warning" : status === "deleted" ? "muted" : "dim";
      return new Text(theme.fg(color, status ? `${glyph} ${status}` : "✓"), 0, 0);
    },
  });
}
