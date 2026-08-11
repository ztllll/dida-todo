import { describe, expect, it } from "vitest";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { registerTodoTool } from "../../extensions/dida-todo/tool.js";
import { getSessionRuntime, removeSessionRuntime, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
import type { TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";

function emptyWork(title: string): WorkTask {
  return {
    remote: { id: "remote-work", projectId: "project", title, status: 0, priority: 0 },
    metadata: { schemaVersion: 1, kind: "pi-todo-work", bindingKey: "tmux:demo:0.0", nextId: 1, tasks: [] },
    tasks: [],
    userContent: "",
  };
}

describe("todo 空清单首次使用", () => {
  it("已绑定但空清单时 list 返回已就绪而不是报错", async () => {
    const sessionId = "ready-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo", label: "demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, {} as DidaTodoRepository, () => {});

    const result = await tool.execute("call", { action: "list" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain("滴答 Todo 已就绪");
    expect(result.content[0].text).toContain("可直接");
    expect(result.details.tasks).toEqual([]);
    expect(result.details.didaProjectId).toBe("project");
    removeSessionRuntime(sessionId);
  });

  it("已同步草稿但没有活动工作时 list 不误报清单为空", async () => {
    const sessionId = "draft-ready-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    const draft = emptyWork("仍在编辑的草稿");
    setSessionRuntime(sessionId, { scope, works: [draft] });
    let tool: any;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, {} as DidaTodoRepository, () => {});

    const result = await tool.execute("call", { action: "list" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain("已同步 1 个顶层任务");
    expect(result.content[0].text).not.toContain("当前清单为空");
    removeSessionRuntime(sessionId);
  });

  it("已绑定但空清单时 clear 幂等成功", async () => {
    const sessionId = "clear-ready-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, {} as DidaTodoRepository, () => {});

    const result = await tool.execute("call", { action: "clear" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain("滴答 Todo 已就绪");
    expect(result.details.tasks).toEqual([]);
    removeSessionRuntime(sessionId);
  });

  it("当前项目已初始化但没有活动工作时，create 自动创建顶层 Dida 工作后再写 Checklist", async () => {
    const sessionId = "bootstrap-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    const calls: string[] = [];
    const repository = {
      async createWork(_scope: TodoScope, title: string) { calls.push(`work:${title}`); return emptyWork(title); },
      async createTask(_scope: TodoScope, _workId: string, input: { subject: string }) {
        calls.push(`task:${input.subject}`);
        const work = emptyWork("更新 CPA");
        work.tasks = [{ id: 1, subject: input.subject, status: "pending" }];
        work.metadata.tasks = work.tasks;
        work.metadata.nextId = 2;
        return work;
      },
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    const result = await tool.execute("call", { action: "create", subject: "准备更新" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(calls).toEqual(["work:准备更新", "task:准备更新"]);
    expect(result.content[0].text).toContain("Created #1");
    expect(getSessionRuntime(sessionId)?.work?.remote.id).toBe("remote-work");
    removeSessionRuntime(sessionId);
  });
});
