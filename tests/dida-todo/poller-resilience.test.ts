import { describe, expect, it } from "vitest";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { startTodoPoller } from "../../extensions/dida-todo/poller.js";
import {
  hasQueueCheckPermission,
  removeSessionRuntime,
  setSessionRuntime,
} from "../../extensions/dida-todo/runtime.js";

function runtimeContext() {
  return {
    sessionManager: { getSessionId: () => "poller-resilience" },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function work(id: string, priority: number): WorkTask {
  return {
    remote: { id, projectId: "project", title: id, status: 0, priority },
    userContent: "",
    tasks: [{ id: 1, subject: "step", status: "pending" }],
    metadata: {
      schemaVersion: 1,
      kind: "pi-todo-work",
      bindingKey: "tmux:demo:0.0",
      nextId: 2,
      tasks: [{ id: 1, subject: "step", status: "pending" }],
    },
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
  await new Promise((done) => setTimeout(done, 0));
}

describe("后台 Poller 自动领取", () => {
  it("启动时同步并领取有优先级工作，同时授予该自动执行 turn 队列权限", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let timerCalls = 0;
    let message = "";
    installRuntime();
    global.setInterval = ((..._args: unknown[]) => {
      timerCalls += 1;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    global.clearInterval = (() => {}) as typeof clearInterval;
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
      const pi = { sendUserMessage(text: string) { message = text; } };
      const stop = startTodoPoller(pi as never, runtimeContext() as never, repository as never, 1, () => {});
      await flush();
      expect(timerCalls).toBe(1);
      expect(message).toContain("自动轮询发现已设置优先级");
      expect(message).toContain("ready");
      expect(message).not.toContain("draft");
      expect(hasQueueCheckPermission("poller-resilience")).toBe(true);
      stop();
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
    installRuntime();
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
      await flush();
      expect(attempts).toBe(1);
      expect(tick).toBeDefined();
      tick?.();
      await flush();
      expect(attempts).toBe(2);
      stop();
    } finally {
      removeSessionRuntime("poller-resilience");
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
