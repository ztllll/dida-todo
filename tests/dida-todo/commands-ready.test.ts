import { describe, expect, it } from "vitest";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { registerCommands } from "../../extensions/dida-todo/commands.js";
import { removeSessionRuntime, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
import type { TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";

describe("/todos 空清单状态", () => {
  it("已绑定且同步成功时明确显示可直接使用", async () => {
    const sessionId = "commands-ready-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo", label: "demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let command: any;
    const notifications: Array<{ message: string; level: string }> = [];
    const repository = {
      async syncOpenWorks() { return { works: [], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerCommands({ registerCommand(_name: string, value: any) { command = value; } } as never, repository, () => {});

    await command.handler("", {
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
    });

    expect(notifications).toEqual([{ message: expect.stringContaining("滴答 Todo 已就绪"), level: "info" }]);
    expect(notifications[0]?.message).toContain("可直接");
    removeSessionRuntime(sessionId);
  });

  it("自动创建验收失败时明确报错，不把夹生工作伪装成普通空状态", async () => {
    const sessionId = "commands-finalization-failure";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo", label: "demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let command: any;
    const notifications: Array<{ message: string; level: string }> = [];
    const repository = {
      async syncOpenWorks() {
        return {
          works: [],
          adoptedWorkIds: [],
          acceptances: [],
          finalizationFailures: [{ workId: "work", title: "夹生工作", error: "create acceptance failed" }],
        };
      },
    } as unknown as DidaTodoRepository;
    registerCommands({ registerCommand(_name: string, value: any) { command = value; } } as never, repository, () => {});

    await command.handler("", {
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
    });

    expect(notifications).toEqual([{ message: expect.stringContaining("create acceptance failed"), level: "error" }]);
    removeSessionRuntime(sessionId);
  });

  it("已同步草稿但没有可执行工作时不误报清单为空", async () => {
    const sessionId = "commands-draft-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo", label: "demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    const draft: WorkTask = {
      remote: { id: "draft", projectId: "project", title: "草稿", status: 0, priority: 0 },
      metadata: { schemaVersion: 1, kind: "pi-todo-work", bindingKey: scope.bindingKey, nextId: 1, tasks: [] },
      tasks: [],
      userContent: "",
    };
    setSessionRuntime(sessionId, { scope, works: [draft] });
    let command: any;
    const notifications: Array<{ message: string; level: string }> = [];
    const repository = {
      async syncOpenWorks() { return { works: [draft], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    } as unknown as DidaTodoRepository;
    registerCommands({ registerCommand(_name: string, value: any) { command = value; } } as never, repository, () => {});

    await command.handler("", {
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
    });

    expect(notifications[0]?.message).toContain("已同步 1 个顶层任务");
    expect(notifications[0]?.message).not.toContain("当前清单为空");
    removeSessionRuntime(sessionId);
  });
});
