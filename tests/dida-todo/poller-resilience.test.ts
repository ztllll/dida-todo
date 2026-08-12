import { describe, expect, it } from "vitest";
import { startTodoPoller } from "../../extensions/dida-todo/poller.js";
import { removeSessionRuntime, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";

function runtimeContext() {
  return {
    sessionManager: { getSessionId: () => "poller-resilience" },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

describe("Poller 韧性", () => {
  it("未确认的验收评论会唤醒；LLM 展示并远端确认后，后续 tick 与 reload 不重复提醒", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let tick: (() => void) | undefined;
    const messages: string[] = [];
    const acknowledged = new Set<string>();
    setSessionRuntime("poller-resilience", {
      scope: {
        binding: { key: "tmux:demo:0.0", projectId: "project" },
        bindingKey: "tmux:demo:0.0",
        cwd: "/workspace/demo",
        sessionId: "poller-resilience",
      },
      works: [],
    });
    global.setInterval = ((callback: () => void) => {
      tick = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    global.clearInterval = (() => {}) as typeof clearInterval;
    try {
      const repository = {
        async syncOpenWorks() {
          const comments = [
            { id: "system", title: "💬 请在此处输入验收意见；如果通过，请直接完成此验收任务。" },
            { id: "feedback", title: "启动前已有但尚未处理的反馈" },
            ...[...acknowledged].map((id) => ({ id: `ack-${id}`, title: `🤖 Pi 已读取验收反馈：${id}` })),
          ];
          return {
            works: [],
            adoptedWorkIds: [],
            acceptances: [{ remote: { id: "acceptance", title: "待验收", status: 0, priority: 1, projectId: "project", tags: ["pi-todo-acceptance"] }, comments }],
            finalizationFailures: [],
          };
        },
      };
      const pi = { sendUserMessage(message: string) { messages.push(message); } };
      const stop = startTodoPoller(pi as never, runtimeContext() as never, repository as never, 1, () => {});
      await new Promise((done) => setTimeout(done, 0));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("新的用户评论");
      expect(messages[0]).toContain("未经用户明确确认不得执行");

      // Represents todo_work acknowledge_feedback after the LLM has actually
      // displayed the feedback to the user.
      acknowledged.add("feedback");

      tick?.();
      await new Promise((done) => setTimeout(done, 0));
      expect(messages).toHaveLength(1);
      stop();

      // A fresh poller represents /reload. The remote acknowledgement keeps
      // the already surfaced feedback silent across process-local state loss.
      const reloadedStop = startTodoPoller(pi as never, runtimeContext() as never, repository as never, 1, () => {});
      await new Promise((done) => setTimeout(done, 0));
      expect(messages).toHaveLength(1);
      reloadedStop();
    } finally {
      removeSessionRuntime("poller-resilience");
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });

  it("同步异常被捕获后保持 timer 存活，后续 tick 仍会执行", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let tick: (() => void) | undefined;
    let attempts = 0;
    setSessionRuntime("poller-resilience", {
      scope: {
        binding: { key: "tmux:demo:0.0", projectId: "project" },
        bindingKey: "tmux:demo:0.0",
        cwd: "/workspace/demo",
        sessionId: "poller-resilience",
      },
      works: [],
    });
    global.setInterval = ((callback: () => void) => {
      tick = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    global.clearInterval = (() => {}) as typeof clearInterval;
    try {
      const repository = {
        async syncOpenWorks() {
          attempts += 1;
          if (attempts === 1) throw new Error("Dida unavailable");
          return { works: [], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] };
        },
      };
      const pi = { sendUserMessage() {} };
      const stop = startTodoPoller(pi as never, runtimeContext() as never, repository as never, 1, () => {});
      await new Promise((done) => setTimeout(done, 0));
      expect(attempts).toBe(1);
      expect(tick).toBeDefined();
      tick?.();
      await new Promise((done) => setTimeout(done, 0));
      expect(attempts).toBe(2);
      stop();
    } finally {
      removeSessionRuntime("poller-resilience");
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
