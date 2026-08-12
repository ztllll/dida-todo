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
