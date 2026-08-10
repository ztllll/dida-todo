import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkTask } from "./domain.js";
import { DidaTodoRepository } from "./repository.js";
import { getSessionRuntime, updateSessionWork, updateSessionWorks } from "./runtime.js";
import { hasUnfinishedTasks, isExecutableWork } from "./work-queue.js";
import { formatWorkSchedule } from "./scheduling.js";

export const TODO_WORK_ACTIONS = ["list", "switch", "next", "refresh", "finish_current"] as const;

export function selectWorkResult(works: WorkTask[], workId: string): WorkTask {
  const work = works.find((candidate) => candidate.remote.id === workId);
  if (!work) throw new Error(`work ${workId} not found`);
  if ((work.remote.priority ?? 0) <= 0) throw new Error(`work ${workId} 没有设置优先级`);
  if (!hasUnfinishedTasks(work)) throw new Error(`work ${workId} 没有未完成步骤`);
  return work;
}

export function registerTodoWorkTool(pi: ExtensionAPI, repository: DidaTodoRepository, onWorkChanged: () => void): void {
  pi.registerTool({
    name: "todo_work",
    label: "Dida Work Queue",
    description: "Internal LLM tool for synchronizing and moving through Dida top-level work. Users normally control it with natural language, not slash commands. Pending acceptance reports and feedback are included in list/refresh results.",
    promptSnippet: "Inspect and switch the Dida top-level work queue",
    promptGuidelines: [
      "When checking todo, process all prioritized unfinished top-level Dida work tasks, not only the currently selected work.",
      "Never execute or mention priority-0 Dida work during automatic checks; it is a draft until the user assigns low, medium, or high priority.",
      "Respect Dida priority and time range when ordering work. High priority is 5, medium 3, low 1; none 0 is not executable.",
      "A pending acceptance is not proof of failure; inspect comments and ask the user before starting rework.",
      "After completing every checklist item, call todo_work finish_current. The repository always creates or reuses the human acceptance Todo before completing the source work; this cannot be skipped by the LLM.",
      "Then call todo_work next and continue until no unfinished work remains or user input is required.",
    ],
    parameters: Type.Object({
      action: StringEnum(TODO_WORK_ACTIONS),
      workId: Type.Optional(Type.String({ description: "Dida top-level work task ID, required for switch" })),
    }),
    async execute(_id, rawParams, signal, _update, ctx) {
      const params = rawParams as {
        action: (typeof TODO_WORK_ACTIONS)[number];
        workId?: string;
      };
      const sessionId = ctx.sessionManager.getSessionId();
      const runtime = getSessionRuntime(sessionId);
      if (!runtime) throw new Error("当前 Pi 会话尚未初始化滴答 Todo");
      const currentId = runtime.work?.remote.id;

      if (params.action === "finish_current") {
        if (!runtime.work) throw new Error("当前没有活动工作任务");
        await repository.finishWork(runtime.scope, runtime.work.remote.id, signal);
      }
      const sync = await repository.syncOpenWorks(runtime.scope, { adoptUnmanaged: true }, signal);
      updateSessionWorks(sessionId, sync.works);
      let selected: WorkTask | undefined;
      if (params.action === "switch") {
        if (!params.workId) throw new Error("workId required for switch");
        selected = selectWorkResult(sync.works, params.workId);
      } else if (params.action === "next" || params.action === "finish_current") {
        const unfinished = sync.works.filter(isExecutableWork);
        const currentIndex = currentId ? sync.works.findIndex((work) => work.remote.id === currentId) : -1;
        selected = currentIndex >= 0
          ? sync.works.slice(currentIndex + 1).find(isExecutableWork) ?? sync.works.slice(0, currentIndex).find(isExecutableWork)
          : unfinished[0];
      } else if (currentId) {
        selected = sync.works.find((work) => work.remote.id === currentId && isExecutableWork(work));
      }
      if (selected) updateSessionWork(sessionId, selected);
      else if (params.action === "next" || params.action === "finish_current") updateSessionWork(sessionId, undefined);
      onWorkChanged();

      const works = sync.works.filter(isExecutableWork).map((work) => ({
        id: work.remote.id,
        title: work.remote.title,
        completed: work.tasks.filter((task) => task.status === "completed").length,
        total: work.tasks.filter((task) => task.status !== "deleted").length,
        selected: work.remote.id === selected?.remote.id,
      }));
      const text = selected
        ? `Selected work: ${selected.remote.title} (${selected.remote.id})\n${formatWorkSchedule(selected.remote)}\n${selected.tasks.filter((task) => task.status !== "deleted").map((task) => `[${task.status}] #${task.id} ${task.subject}`).join("\n") || "[pending] 尚无 Checklist；先根据顶层任务标题分析工作并创建执行步骤"}`
        : works.length
          ? `Unfinished works:\n${works.map((work) => `- ${work.title} [${work.completed}/${work.total}] (${work.id})`).join("\n")}`
          : "No unfinished Dida work tasks";
      return {
        content: [{ type: "text", text: `${text}${sync.acceptances.length ? `\n\nPending human acceptance:\n${sync.acceptances.map(({ remote, comments }) => `- ${remote.title} (${remote.id}) · feedback ${comments.length}`).join("\n")}` : ""}` }],
        details: {
          action: params.action,
          works,
          selectedWorkId: selected?.remote.id,
          acceptances: sync.acceptances.map(({ remote, comments }) => ({ id: remote.id, title: remote.title, content: remote.content, comments })),
        },
      };
    },
  });
}
