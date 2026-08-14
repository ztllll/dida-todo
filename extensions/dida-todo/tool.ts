import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import type { DidaWorkPriority, DidaWorkType, Task, TaskStatus, TodoScope, WorkTask } from "./domain.js";
import { DidaTodoRepository, type CreateTaskInput, type UpdateTaskInput } from "./repository.js";
import { allowedTrackingReasons, getActiveTasks, getSessionRuntime, queueWorkFinalization, resolveWorkFinalization, updateSessionWork } from "./runtime.js";
import { DIDA_TRACKING_REASONS, type TodoTrackingReason } from "./tracking-policy.js";
import { requiresExplicitWorkCompletion } from "./work-type.js";


export interface TodoParams {
  action: "create" | "update" | "list" | "get" | "delete" | "clear";
  subject?: string;
  workTitle?: string;
  workDescription?: string;
  workContent?: string;
  workType?: DidaWorkType;
  workPriority?: DidaWorkPriority;
  trackingReason?: TodoTrackingReason;
  allowNonChinese?: boolean;
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

const WORK_PRIORITY_VALUES: Record<DidaWorkPriority, 1 | 3 | 5> = { low: 1, medium: 3, high: 5 };

function normalizedTaskText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sameTaskText(left: string, right: string): boolean {
  return normalizedTaskText(left) === normalizedTaskText(right);
}

const CHINESE_CHARACTER = /\p{Script=Han}/u;

export function requireChineseCreationText(params: TodoParams): void {
  if (params.allowNonChinese) return;
  const fields: ReadonlyArray<readonly [string, string | undefined]> = [
    ["subject", params.subject],
    ["workTitle", params.workTitle],
    ["workDescription", params.workDescription],
    ["workContent", params.workContent],
    ["description", params.description],
  ];
  const nonChineseField = fields.find(([, value]) => value?.trim() && !CHINESE_CHARACTER.test(value));
  if (nonChineseField) {
    throw new Error(`${nonChineseField[0]} 必须用中文表达；仅在用户明确要求保留非中文内容时才能设置 allowNonChinese=true`);
  }
}

function requireInitializedRuntime(sessionId: string): { scope: TodoScope; work?: WorkTask; works: WorkTask[] } {
  const runtime = getSessionRuntime(sessionId);
  if (!runtime) throw new Error("当前 OMP 会话尚未初始化滴答 Todo");
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

export function registerDidaTodoTool(pi: ExtensionAPI, repository: DidaTodoRepository, onWorkChanged: () => void): void {
  const Type = pi.typebox.Type;
  const enumSchema = (values: readonly string[], description?: string) => Type.Union(
    values.map((value) => Type.Literal(value)),
    description ? { description } : undefined,
  );
  const Params = Type.Object({
    action: enumSchema(["create", "update", "list", "get", "delete", "clear"]),
    subject: Type.Optional(Type.String({ description: "Required for create. For direct work, use an LLM-organized concise task name. For checklist work, use one concrete Item that is distinct from the aggregate workTitle." })),
    workTitle: Type.Optional(Type.String({ description: "LLM-generated concise aggregate title for checklist work only. It must summarize the whole objective and must not duplicate the first concrete subject." })),
    workDescription: Type.Optional(Type.String({ description: "Top-level Dida task description, distinct from the Checklist step description." })),
    workContent: Type.Optional(Type.String({ description: "Top-level Dida task body/details, distinct from Checklist Items." })),
    workType: Type.Optional(enumSchema(["direct", "checklist"], "Required when create starts a new work. direct keeps execution steps in managed metadata; checklist writes visible Dida Checklist Items and requires explicit top-level completion.")),
    workPriority: Type.Optional(enumSchema(["low", "medium", "high"], "Required when create starts a new top-level work. Choose actual urgency/impact: low=1, medium=3, high=5. Priority 0 is reserved for user drafts.")),
    trackingReason: Type.Optional(enumSchema(DIDA_TRACKING_REASONS, "Required for every create. Use current_work_step only for a genuine additional step of the active Dida work; otherwise use one durable top-level tracking reason. Ordinary chat, Q&A, one-off research, read-only inspection, translation, summarization, or merely using multiple tools are not valid reasons.")),
    allowNonChinese: Type.Optional(Type.Boolean({ description: "Defaults to false. New Todo text must use Chinese semantics. Set true only when the user explicitly requests non-Chinese text; retain Chinese action and goal wording whenever possible." })),
    description: Type.Optional(Type.String({ description: "Long-form task description" })),
    activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while in_progress" })),
    status: Type.Optional(enumSchema(["pending", "in_progress", "completed", "skipped", "deleted"], "Use skipped only when the requested deliverable is intentionally left unchecked or not applicable; it is treated as settled while the Dida Item remains unchecked.")),
    blockedBy: Type.Optional(Type.Array(Type.Number())),
    addBlockedBy: Type.Optional(Type.Array(Type.Number())),
    removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
    owner: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    id: Type.Optional(Type.Number()),
    includeDeleted: Type.Optional(Type.Boolean()),
  });
  pi.registerTool({
    name: "dida_todo",
    label: "Dida Todo",
    description: "Manage durable, explicitly tracked Dida work. Do not call for ordinary chat, simple Q&A, one-off research, read-only inspection, translation, rewriting, or summarization. Dida is the source of truth for work that genuinely needs persistent progress. New Todo text must use Chinese semantics unless the user explicitly authorizes allowNonChinese=true.",
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
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
      if (params.action === "create") requireChineseCreationText(params);
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
        if (!params.trackingReason || params.trackingReason === "current_work_step") {
          throw new Error("trackingReason required：新顶层 Todo 只能使用用户明确追踪、多步骤实施、跨轮恢复或后台验收理由；普通聊天、问答和一次性查询不得创建");
        }
        if (!params.workType) throw new Error("workType required：新工作必须明确 direct 或 checklist");
        if (!params.workPriority) throw new Error("workPriority required：LLM 新建顶层工作必须根据紧急性和影响选择 low、medium 或 high；priority=0 仅保留给用户草稿");
        if (params.workType === "checklist" && !params.workTitle?.trim()) {
          throw new Error("workTitle required：Checklist 大任务必须提供 LLM 智能生成的汇总标题");
        }
        if (params.workType === "checklist" && sameTaskText(params.workTitle!, params.subject)) {
          throw new Error("Checklist 汇总标题不能与首个具体任务相同；workTitle 应概括整组工作，subject 应明确当前 Item");
        }
        if (params.workType === "direct" && params.workTitle?.trim()) {
          throw new Error("Direct 工作没有额外汇总标题：请省略 workTitle，并把智能整理后的任务名放入 subject");
        }
        work = await repository.createWork(
          scope,
          params.workType === "checklist" ? params.workTitle!.trim() : params.subject.trim(),
          signal,
          params.workType,
          params.workContent,
          params.workType === "direct" ? params.workDescription ?? params.description : params.workDescription,
          WORK_PRIORITY_VALUES[params.workPriority],
        );
        startedNewWork = true;
        updateSessionWork(sessionId, work);
      }
      if (work.remote.status !== 0 && params.action === "create" && params.subject) {
        if (!params.trackingReason || params.trackingReason === "current_work_step") {
          throw new Error("trackingReason required：新顶层 Todo 只用于需要持久追踪的用户工作");
        }
        if (!params.workType) throw new Error("workType required：新工作必须明确 direct 或 checklist");
        if (!params.workPriority) throw new Error("workPriority required：LLM 新建顶层工作必须设置 low、medium 或 high");
        if (params.workType === "checklist" && !params.workTitle?.trim()) throw new Error("workTitle required：Checklist 大任务必须提供 LLM 智能生成的汇总标题");
        if (params.workType === "checklist" && sameTaskText(params.workTitle!, params.subject)) {
          throw new Error("Checklist 汇总标题不能与首个具体任务相同；workTitle 应概括整组工作，subject 应明确当前 Item");
        }
        if (params.workType === "direct" && params.workTitle?.trim()) {
          throw new Error("Direct 工作没有额外汇总标题：请省略 workTitle，并把智能整理后的任务名放入 subject");
        }
        work = await repository.createWork(
          scope,
          params.workType === "checklist" ? params.workTitle!.trim() : params.subject.trim(),
          signal,
          params.workType,
          params.workContent,
          params.workType === "direct" ? params.workDescription ?? params.description : params.workDescription,
          WORK_PRIORITY_VALUES[params.workPriority],
        );
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
          && !requiresExplicitWorkCompletion(nextWork)
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
    renderCall(args, _options, theme) {
      const params = args as TodoParams;
      let text = theme.fg("toolTitle", theme.bold("dida_todo ")) + theme.fg("muted", params.action);
      if (params.subject) text += ` ${theme.fg("dim", params.subject)}`;
      if (params.id !== undefined) {
        const task = getActiveTasks().find((candidate) => candidate.id === params.id);
        text += ` ${theme.fg("accent", task?.subject ?? `#${params.id}`)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _args) {
      const details = result.details as { params?: TodoParams; tasks?: Task[] } | undefined;
      const task = details?.tasks?.find((candidate) => candidate.id === details.params?.id) ?? details?.tasks?.at(-1);
      const status = task?.status;
      const glyph = status === "completed" ? "✓" : status === "skipped" ? "−" : status === "in_progress" ? "◐" : status === "deleted" ? "⊘" : "○";
      const color = status === "completed" ? "success" : status === "skipped" ? "muted" : status === "in_progress" ? "warning" : status === "deleted" ? "muted" : "dim";
      return new Text(theme.fg(color, status ? `${glyph} ${status}` : "✓"), 0, 0);
    },
  });
}
