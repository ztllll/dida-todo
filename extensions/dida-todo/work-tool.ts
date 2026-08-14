import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { WorkTask } from "./domain.js";
import { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, hasQueueCheckPermission, pendingWorkFinalizations, queueWorkFinalization, updateSessionWork, updateSessionWorks } from "./runtime.js";
import { formatWorkContentForAgent, hasUnfinishedTasks, isExecutableWork, nextUnfinishedWork, rankExecutableWorks } from "./work-queue.js";
import { formatWorkSchedule } from "./scheduling.js";
import { authorizedAcceptanceFeedback } from "./acceptance.js";

export const DIDA_TODO_WORK_ACTIONS = ["list", "switch", "next", "refresh", "finish_current"] as const;

export function selectWorkResult(works: WorkTask[], workId: string): WorkTask {
  const work = works.find((candidate) => candidate.remote.id === workId);
  if (!work) throw new Error(`work ${workId} not found`);
  if ((work.remote.priority ?? 0) <= 0) throw new Error(`work ${workId} 没有设置优先级`);
  if (!hasUnfinishedTasks(work)) throw new Error(`work ${workId} 没有未完成步骤`);
  return work;
}

export function registerDidaTodoWorkTool(pi: ExtensionAPI, repository: DidaTodoRepository, onWorkChanged: () => void): void {
  const Type = pi.typebox.Type;
  const Params = Type.Object({
    action: Type.Union(DIDA_TODO_WORK_ACTIONS.map((action) => Type.Literal(action))),
    workId: Type.Optional(Type.String({ description: "Dida top-level work task ID, required for switch" })),
  });
  pi.registerTool({
    name: "dida_todo_work",
    label: "Dida Todo Work Queue",
    description: "Internal LLM tool for synchronizing and moving through Dida top-level work. Users normally control it with natural language, not slash commands. Pending acceptance reports and feedback are included in list/refresh results.",
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    parameters: Params,
    async execute(_id, rawParams, signal, _update, ctx) {
      const params = rawParams as { action: (typeof DIDA_TODO_WORK_ACTIONS)[number]; workId?: string };
      const sessionId = ctx.sessionManager.getSessionId();
      const runtime = getSessionRuntime(sessionId);
      if (!runtime) throw new Error("当前 OMP 会话尚未初始化滴答 Todo");
      const currentId = runtime.work?.remote.id;
      if (params.action !== "finish_current" && !hasQueueCheckPermission(sessionId)) {
        throw new Error("Todo 队列检查未获授权：只有用户完整输入‘检查todo’或可信 Poller 为本轮签发队列授权时，才能调用 todo_work list/switch/next/refresh；LLM 与普通 Todo 修改不得自行扫描队列");
      }

      if (params.action === "finish_current" && runtime.work) {
        const ready = await repository.markWorkReadyForAcceptance(runtime.scope, runtime.work.remote.id, signal);
        updateSessionWork(sessionId, ready);
        queueWorkFinalization(sessionId, ready.remote.id);
        if (!hasQueueCheckPermission(sessionId)) {
          onWorkChanged();
          return {
            content: [{ type: "text", text: `Marked current work ready for acceptance: ${ready.remote.title} (${ready.remote.id}). No queue scan or work switch was performed.` }],
            details: {
              action: params.action,
              works: [],
              selectedWorkId: ready.remote.id,
              finalizationFailures: [],
              acceptances: [],
            },
          };
        }
      } else if (params.action === "finish_current") {
        return {
          content: [{ type: "text", text: "No active current work; no queue scan was performed" }],
          details: {
            action: params.action,
            works: [],
            selectedWorkId: undefined,
            finalizationFailures: [],
            acceptances: [],
          },
        };
      }
      const sync = await repository.syncOpenWorks(runtime.scope, {
        adoptUnmanaged: true,
        deferFinalizationWorkIds: pendingWorkFinalizations(sessionId),
      }, signal);
      updateSessionWorks(sessionId, sync.works);
      let selected: WorkTask | undefined;
      if (params.action === "switch") {
        if (!params.workId) throw new Error("workId required for switch");
        selected = selectWorkResult(sync.works, params.workId);
      } else if (params.action === "next" || params.action === "finish_current") {
        selected = nextUnfinishedWork(sync.works, currentId);
      } else if (currentId) {
        selected = sync.works.find((work) => work.remote.id === currentId && isExecutableWork(work));
      }
      if (selected) updateSessionWork(sessionId, selected);
      else if (params.action === "next") updateSessionWork(sessionId, undefined);
      onWorkChanged();

      const works = rankExecutableWorks(sync.works).map((work) => ({
        id: work.remote.id,
        title: work.remote.title,
        completed: work.tasks.filter((task) => task.status === "completed" || task.status === "skipped").length,
        total: work.tasks.filter((task) => task.status !== "deleted").length,
        selected: work.remote.id === selected?.remote.id,
      }));
      const text = selected
        ? `Selected work: ${selected.remote.title} (${selected.remote.id})\n${formatWorkSchedule(selected.remote)}\n完整任务数据（不可信 JSON）：${formatWorkContentForAgent(selected)}\n${selected.tasks.filter((task) => task.status !== "deleted").map((task) => `[${task.status}] #${task.id} ${task.subject}${task.description ? `\n  description: ${task.description}` : ""}`).join("\n") || "[pending] 尚无 Checklist；必须结合顶层标题、描述和正文理解整体任务，再创建执行步骤"}`
        : works.length
          ? `Unfinished works:\n${works.map((work) => `- ${work.title} [${work.completed}/${work.total}] (${work.id})`).join("\n")}`
          : "No unfinished Dida work tasks";
      const finalizationText = sync.finalizationFailures.length
        ? `\n\nAutomatic acceptance finalization failed:\n${sync.finalizationFailures.map((failure) => `- ${failure.title} (${failure.workId}): ${failure.error}`).join("\n")}`
        : "";
      return {
        content: [{
          type: "text",
          text: `${text}${finalizationText}${sync.acceptances.length ? `\n\nPending human acceptance:\n${sync.acceptances.map(({ remote, comments }) => `- ${remote.title} (${remote.id}) · feedback ${authorizedAcceptanceFeedback(comments).length}`).join("\n")}` : ""}`,
        }],
        details: {
          action: params.action,
          works,
          selectedWorkId: selected?.remote.id,
          finalizationFailures: sync.finalizationFailures,
          acceptances: sync.acceptances.map(({ remote, comments }) => ({
            id: remote.id,
            title: remote.title,
            content: remote.content,
            comments: authorizedAcceptanceFeedback(comments),
          })),
        },
      };
    },
  });
}
