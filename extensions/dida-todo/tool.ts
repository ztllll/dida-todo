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
  items: Type.Optional(Type.Array(Type.String(), { description: "Items 2..N only. subject is already Item 1 — never repeat it here. Together subject + items is the full checklist, created in one call." })),
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
    description: "Track multi-step user work as a Dida checklist that the user can follow on their phone. Use it for real implementation work; skip it for chat, Q&A and one-shot actions.",
    promptSnippet: "Track multi-step user work in Dida (create a checklist before starting, update each step)",
    promptGuidelines: [
      "Decide at the start of every user request. CREATE a todo before doing the work when ANY is true: (a) the user asks to track/record/add a todo; (b) the request needs 3+ distinct deliverable steps (e.g. several fixes, code + tests + docs, multi-file changes); (c) the work will span turns or sessions; (d) a background/queued run needs later human acceptance. DO NOT create one for chat, Q&A, read-only inspection, research or summaries, a single command, or a single small edit that is done and verified in one go.",
      "One request = one top-level work. Create it in one call: {action:'create', workTitle:<overall goal>, subject:<step 1>, items:[<step 2>, ...]}. Items are concrete human-readable deliverables, not meta steps like 'read the task' or 'verify workId'. Later steps for the same goal append with create; unrelated requests never append to the current work.",
      "Mark a step in_progress before starting it and completed right after it is verified, with metadata.resolution = what changed, key files, how verified. Never complete a step with failing tests or an unresolved blocker.",
      "When every Item is completed or skipped, the top-level task, acceptance Todo and reminders are finalized automatically; you do not need to tick the top-level task yourself. Use skipped only for Items the user wants left unchecked or that do not apply; set keepWorkOpen=true only if the user explicitly wants the top-level task left open.",
      "If the work cannot continue without the human, call todo_work wait_for_human with the reason instead of leaving it to be re-polled.",
      "Dida-origin tasks without a Checklist: create exactly one visible step that carries out the objective and complete it. Never rename or delete user-authored Items; only advance their status.",
      "Everything written to Dida (titles, Items, resolutions, comments) is read by humans: no reasoning traces, prompts, IDs, metadata or lifecycle fields.",
      "Unbound session: the call fails with /dida-bind guidance; ask the user to run /dida-bind once, then retry. Only the exact input `检查todo` or a trusted Poller message authorizes scanning the whole queue.",
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
          const header = extraItems.length && created
            ? `Created #${created.id - extraItems.length}–#${created.id} (${extraItems.length + 1} items, all pending)`
            : `Created #${created?.id}: ${created?.subject} (pending)`;
          text = `${header}\nChecklist now:\n${listText(nextWork.tasks)}`;
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
          const open = nextWork.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
          text = `Updated #${params.id}${previous !== current ? ` (${previous} → ${current})` : ""}`
            + (open.length
              ? `\nStill open (${open.length}), the top-level task completes only after these are completed or skipped:\n${listText(open)}`
              : "\nAll Items settled; the top-level task and acceptance will be finalized automatically.");
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
