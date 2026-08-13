import { describe, expect, it } from "vitest";
import { classifyTodoTrackingReasons } from "../../extensions/dida-todo/tracking-policy.js";

describe("Todo 持久追踪意图门", () => {
  it.each([
    "你好，今天怎么样？",
    "解释一下 TypeScript 的 unknown 和 any",
    "联网查询适合 Pi 用的记忆系统",
    "查看一下当前 Node 版本",
    "翻译这段英文",
    "总结这篇文章",
    "对比 Mem0 和 MemOS 的区别",
    "帮我诊断为什么这个请求慢，先不要改代码",
  ])("普通聊天或一次性信息请求不授权 Todo：%s", (text) => {
    expect(classifyTodoTrackingReasons(text)).toEqual([]);
  });

  it("明确要求加入清单时允许持久追踪", () => {
    expect(classifyTodoTrackingReasons("把升级数据库加入 Todo 并持续跟踪进度")).toEqual(expect.arrayContaining([
      "user_requested_tracking",
      "current_work_step",
    ]));
  });

  it("明确实施代码或部署时允许多步骤实施", () => {
    expect(classifyTodoTrackingReasons("修复登录并部署到测试环境")).toEqual(expect.arrayContaining([
      "multi_step_implementation",
      "current_work_step",
    ]));
  });

  it("跨会话和后台验收各自有明确理由", () => {
    expect(classifyTodoTrackingReasons("分阶段实现，跨会话持续推进")).toEqual(expect.arrayContaining(["cross_turn_recovery"]));
    expect(classifyTodoTrackingReasons("后台运行迁移，完成后通知我验收")).toEqual(expect.arrayContaining(["background_or_acceptance"]));
  });

  it("用户批准上一轮方案时视为实施授权", () => {
    expect(classifyTodoTrackingReasons("对，按照这个来")).toEqual(expect.arrayContaining([
      "multi_step_implementation",
      "current_work_step",
    ]));
  });
});
