import type { WorkTask } from "./domain.js";
import type { PendingAcceptance } from "./repository.js";
import { formatWorkSchedule } from "./scheduling.js";
import { formatAcceptanceForAgent } from "./acceptance.js";

export function hasUnfinishedTasks(work: WorkTask): boolean {
  const visible = work.tasks.filter((task) => task.status !== "deleted");
  if (visible.length === 0) return work.remote.status === 0;
  return visible.some((task) => task.status === "pending" || task.status === "in_progress");
}

export function isExecutableWork(work: WorkTask): boolean {
  return (work.remote.priority ?? 0) > 0 && hasUnfinishedTasks(work);
}

export function nextUnfinishedWork(works: WorkTask[], currentWorkId?: string): WorkTask | undefined {
  const eligible = works.filter(isExecutableWork);
  if (!eligible.length) return undefined;
  if (!currentWorkId) return eligible[0];
  const currentIndex = works.findIndex((work) => work.remote.id === currentWorkId);
  if (currentIndex < 0) return eligible[0];
  return works.slice(currentIndex + 1).find(isExecutableWork) ?? works.slice(0, currentIndex).find(isExecutableWork);
}

export function formatWorkQueueForAgent(works: WorkTask[], adoptedCount = 0, acceptances: PendingAcceptance[] = []): string {
  const unfinished = works.filter(isExecutableWork);
  const workLines = unfinished.map((work) => {
    const visible = work.tasks.filter((task) => task.status !== "deleted");
    const done = visible.filter((task) => task.status === "completed").length;
    const progress = visible.length ? `[${done}/${visible.length}]` : "[尚无 Checklist，仍需执行]";
    return `- ${work.remote.title} ${progress} (workId: ${work.remote.id})\n  ${formatWorkSchedule(work.remote).replaceAll("\n", " · ")}`;
  });
  const acceptanceLines = acceptances.map(({ remote, comments }) => formatAcceptanceForAgent(remote, comments));
  return [
    "已从滴答清单同步项目 Todo。以下是全部已设置优先级且未完成的顶层工作任务，不是只处理第一项。无优先级任务视为用户仍在编辑的草稿，必须静默跳过。请按顺序执行；完成一个顶层工作后继续检查并切换到下一个，直到队列为空、任务存在歧义/风险需要用户确认，或遇到无法解决的阻塞。执行过程中使用 todo 更新 Checklist 状态，并在完成时写入 metadata.resolution。",
    ...(adoptedCount ? [`本次自动接管了 ${adoptedCount} 个用户手工创建的滴答任务。`] : []),
    ...(workLines.length ? workLines : ["- 当前没有未完成工作任务"]),
    ...(acceptanceLines.length ? ["", "以下任务正在等待人类验收。不要当作普通实现任务自动执行；如果有用户反馈或长时间未完成，应主动询问用户是否需要优化或返工：", ...acceptanceLines] : []),
  ].join("\n");
}
