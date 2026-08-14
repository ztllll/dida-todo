import { describe, expect, it } from "bun:test";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { startTodoPoller } from "../../extensions/dida-todo/poller.js";
import {
  hasQueueCheckPermission,
  removeSessionRuntime,
  setSessionRuntime,
} from "../../extensions/dida-todo/runtime.js";

function runtimeContext(onInterval?: (callback: () => void) => void) {
  return {
    sessionManager: { getSessionId: () => "poller-resilience" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    setInterval(callback: () => void) {
      onInterval?.(callback);
      return "poller-timer";
    },
    clearTimer() {},
  };
}

function work(id: string, priority: number): WorkTask {
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority },
    userContent: "",
    tasks: [{ id: 1, subject: "step", status: "pending" }],
    metadata: { schemaVersion: 3, kind: "dida-todo-work", bindingKey: "tmux:demo:0.0", origin: "dida", lifecycle: "draft", nextId: 2, tasks: [{ id: 1, subject: "step", status: "pending" }], },
  };
}

function installRuntime(): void {
  setSessionRuntime("poller-resilience", {
    scope: {
      binding: { key: "tmux:demo:0.0", projectId: "project" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      sessionId: "poller-resilience",
    },
    works: [],
  });
}
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("后台 Poller 自动领取", () => {
  it("启动时同步并领取有优先级工作，同时授予该自动执行 turn 队列权限", async () => {
    let timerCalls = 0;
    let message = "";
    installRuntime();
    try {
      const repository = {
        async syncOpenWorks() {
          return {
            works: [work("draft", 0), work("ready", 3)],
            adoptedWorkIds: ["ready"],
            acceptances: [],
            finalizationFailures: [],
          };
        },
      };
      const pi = { logger: { error() {} }, sendUserMessage(text: string) { message = text; } };
      const stop = startTodoPoller(pi as never, runtimeContext(() => { timerCalls += 1; }) as never, repository as never, 1, () => {});
      await flush();
      expect(timerCalls).toBe(1);
      expect(message).toContain("自动轮询发现已设置优先级");
      expect(message).toContain("ready");
      expect(message).not.toContain("draft");
      expect(hasQueueCheckPermission("poller-resilience")).toBe(true);
      stop();
    } finally {
      removeSessionRuntime("poller-resilience");
    }
  });

  it("同步异常被捕获后保持 timer 存活，后续 tick 仍会执行", async () => {
    let tick: (() => void) | undefined;
    let attempts = 0;
    installRuntime();
    try {
      const repository = {
        async syncOpenWorks() {
          attempts += 1;
          if (attempts === 1) throw new Error("Dida unavailable");
          return { works: [], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] };
        },
      };
      const pi = { logger: { error() {} }, sendUserMessage() {} };
      const stop = startTodoPoller(pi as never, runtimeContext((callback) => { tick = callback; }) as never, repository as never, 1, () => {});
      await flush();
      expect(attempts).toBe(1);
      expect(tick).toBeDefined();
      tick?.();
      await flush();
      expect(attempts).toBe(2);
      stop();
    } finally {
      removeSessionRuntime("poller-resilience");
    }
  });
});
