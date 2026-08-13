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

describe("后台 Poller 禁用", () => {
  it("启动后不访问远端、不创建 timer、不发送消息", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let timerCalls = 0;
    let syncCalls = 0;
    let messageCalls = 0;
    setSessionRuntime("poller-resilience", {
      scope: {
        binding: { key: "tmux:demo:0.0", projectId: "project" },
        bindingKey: "tmux:demo:0.0",
        cwd: "/workspace/demo",
        sessionId: "poller-resilience",
      },
      works: [],
    });
    global.setInterval = ((..._args: unknown[]) => {
      timerCalls += 1;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    global.clearInterval = (() => {}) as typeof clearInterval;
    try {
      const repository = {
        async syncOpenWorks() { syncCalls += 1; throw new Error("不应访问远端"); },
      };
      const pi = { sendUserMessage() { messageCalls += 1; } };
      const stop = startTodoPoller(pi as never, runtimeContext() as never, repository as never, 1, () => {});
      await new Promise((done) => setTimeout(done, 0));
      expect(syncCalls).toBe(0);
      expect(timerCalls).toBe(0);
      expect(messageCalls).toBe(0);
      stop();
    } finally {
      removeSessionRuntime("poller-resilience");
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
