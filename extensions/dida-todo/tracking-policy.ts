export const TODO_TRACKING_REASONS = [
  "user_requested_tracking",
  "multi_step_implementation",
  "cross_turn_recovery",
  "background_or_acceptance",
  "current_work_step",
] as const;

export type TodoTrackingReason = (typeof TODO_TRACKING_REASONS)[number];

const EXPLICIT_TRACKING = /(?:\btodo\b|待办|滴答|dida|任务清单|加入.{0,4}清单|记到.{0,4}清单|记录.{0,6}(?:任务|进度)|跟踪.{0,6}(?:任务|进度)|追踪.{0,6}(?:任务|进度))/i;
const IMPLEMENTATION = /(?:帮我|请|需要|把|将|给我|现在|直接|去)?\s*(?:修复|实现|开发|编写|新增|添加|修改|更改|删除|重构|部署|安装|升级|迁移|发布|配置|接入|替换|启用|禁用|优化|落地|制作)/i;
const ONE_OFF_INFORMATION = /(?:联网)?(?:查询|查找|搜索|搜一下|了解|介绍|解释|对比|比较|分析|总结|翻译|润色|看看|查看|核对|确认).{0,20}(?:什么|哪些|是否|能否|可以|情况|资料|方案|系统|版本|状态)?/i;
const CROSS_TURN = /(?:跨(?:轮|会话)|稍后继续|之后继续|下次继续|分阶段|长期跟踪|中断后恢复|持续推进)/i;
const BACKGROUND = /(?:后台执行|后台运行|完成后通知|完成后验收|等待.{0,8}(?:完成|结果)|人类验收|持续监控)/i;
const CURRENT_WORK = /(?:继续|接着|下一步|当前任务|当前工作|按这个来|按照这个来|就这么做|继续处理|检查\s*todo|执行.{0,6}(?:todo|待办|滴答))/i;
const APPROVED_EXECUTION = /(?:^|[，,。\s])(?:对|好|可以|行|确认)?[，,。\s]*(?:按这个来|按照这个来|就这么做|直接做|开始实施|开始执行)(?:$|[，,。！!\s])/i;

export function classifyTodoTrackingReasons(text: string): TodoTrackingReason[] {
  const value = text.trim();
  const reasons = new Set<TodoTrackingReason>();
  if (EXPLICIT_TRACKING.test(value)) reasons.add("user_requested_tracking");
  if (CROSS_TURN.test(value)) reasons.add("cross_turn_recovery");
  if (BACKGROUND.test(value)) reasons.add("background_or_acceptance");
  if (CURRENT_WORK.test(value)) reasons.add("current_work_step");
  if (APPROVED_EXECUTION.test(value)) reasons.add("multi_step_implementation");
  // Informational requests often mention words such as “安装” or “配置” while
  // asking only for research. They must not be upgraded to implementation work.
  if (IMPLEMENTATION.test(value) && !ONE_OFF_INFORMATION.test(value)) reasons.add("multi_step_implementation");
  if ([...reasons].some((reason) => reason !== "current_work_step")) reasons.add("current_work_step");
  return [...reasons];
}
