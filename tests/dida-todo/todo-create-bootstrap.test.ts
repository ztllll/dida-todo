import { describe, expect, it } from "vitest";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { registerTodoTool } from "../../extensions/dida-todo/tool.js";
import { getSessionRuntime, removeSessionRuntime, setAllowedTrackingReasons, setSessionRuntime } from "../../extensions/dida-todo/runtime.js";
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

  it("缺省 workType/workPriority 时使用默认值 checklist/medium 创建", async () => {
    const sessionId = "missing-work-priority";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    const calls: Array<{ title: string; workType?: string; priority?: number }> = [];
    const repository = {
      async createWork(_scope: TodoScope, title: string, _signal?: AbortSignal, workType?: string, _content?: string, _description?: string, priority?: number) {
        calls.push({ title, workType, priority });
        return emptyWork(title);
      },
      async createTask(_scope: TodoScope, _workId: string, input: { subject: string }) {
        const work = emptyWork(input.subject);
        work.tasks = [{ id: 1, subject: input.subject, status: "pending" }];
        work.metadata.tasks = work.tasks;
        work.metadata.nextId = 2;
        return work;
      },
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    await tool.execute("call", {
      action: "create",
      workType: "direct",
      subject: "整理发布说明",
    }, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } });

    expect(calls).toEqual([{ title: "整理发布说明", workType: "direct", priority: 3 }]);
    removeSessionRuntime(sessionId);
  });

  it("绑定会话内仅凭 subject 即可创建新工作，不再要求授权理由", async () => {
    const sessionId = "no-tracking-reason";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    const calls: Array<{ title: string; workType?: string; priority?: number }> = [];
    const repository = {
      async createWork(_scope: TodoScope, title: string, _signal?: AbortSignal, workType?: string, _content?: string, _description?: string, priority?: number) {
        calls.push({ title, workType, priority });
        return emptyWork(title);
      },
      async createTask(_scope: TodoScope, _workId: string, input: { subject: string }) {
        const work = emptyWork(input.subject);
        work.tasks = [{ id: 1, subject: input.subject, status: "pending", metadata: (input as any).metadata }];
        work.metadata.tasks = work.tasks;
        work.metadata.nextId = 2;
        return work;
      },
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    const result = await tool.execute("call", { action: "create", subject: "查询一个问题" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(result.content[0].text).toContain("Created #1");
    expect(calls).toEqual([{ title: "查询一个问题", workType: "checklist", priority: 3 }]);
    removeSessionRuntime(sessionId);
  });

  it("有活动工作时，追加步骤无需声明 current_work_step，审计理由自动补齐", async () => {
    const sessionId = "append-reason-session";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      sessionId,
    };
    const active = emptyWork("持久实施工作");
    active.tasks = [{ id: 1, subject: "原步骤", status: "pending" }];
    active.metadata.tasks = active.tasks;
    active.metadata.nextId = 2;
    setSessionRuntime(sessionId, { scope, works: [active], work: active });
    let tool: any;
    const inputs: Array<{ subject: string; metadata?: Record<string, unknown> }> = [];
    const repository = {
      async createTask(_scope: TodoScope, _workId: string, input: { subject: string; metadata?: Record<string, unknown> }) {
        inputs.push({ subject: input.subject, metadata: input.metadata });
        return active;
      },
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    await tool.execute("call", { action: "create", subject: "顺便问个问题" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(inputs).toEqual([{ subject: "顺便问个问题", metadata: { trackingReason: "current_work_step" } }]);
    removeSessionRuntime(sessionId);
  });

  it("Direct 工作把智能整理后的 subject 作为唯一任务名，并将 description 写入顶层详情", async () => {
    const sessionId = "direct-title-semantics";
    const scope: TodoScope = {
      binding: { key: "tmux:demo:0.0", projectId: "project", cwd: "/workspace/demo" },
      bindingKey: "tmux:demo:0.0",
      cwd: "/workspace/demo",
      tmuxTarget: "demo:0.0",
      sessionId,
    };
    setSessionRuntime(sessionId, { scope, works: [] });
    let tool: any;
    const calls: Array<{ title: string; workType?: string; description?: string; priority?: number }> = [];
    const repository = {
      async createWork(_scope: TodoScope, title: string, _signal?: AbortSignal, workType?: string, _content?: string, description?: string, priority?: number) {
        calls.push({ title, workType, description, priority });
        return emptyWork(title);
      },
      async createTask(_scope: TodoScope, _workId: string, input: { subject: string; description?: string }) {
        const work = emptyWork(input.subject);
        work.tasks = [{ id: 1, subject: input.subject, description: input.description, status: "pending" }];
        work.metadata.tasks = work.tasks;
        work.metadata.nextId = 2;
        return work;
      },
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});
    setAllowedTrackingReasons(sessionId, ["user_requested_tracking", "current_work_step"]);

    await tool.execute("call", {
      action: "create",
      workType: "direct",
      workPriority: "medium",
      subject: "收窄 Todo 检查触发词",
      description: "只有完整输入检查todo才扫描队列，其他口述只做对应修改。",
      trackingReason: "user_requested_tracking",
    }, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } });

    expect(calls).toEqual([{
      title: "收窄 Todo 检查触发词",
      workType: "direct",
      description: "只有完整输入检查todo才扫描队列，其他口述只做对应修改。",
      priority: 3,
    }]);
    removeSessionRuntime(sessionId);
  });

  it("Checklist 缺省 workTitle 兼作汇总标题；有活动工作时 create 追加并写入审计理由", async () => {
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
      async createWork(_scope: TodoScope, title: string, _signal?: AbortSignal, workType?: string, _content?: string, _description?: string, priority?: number) {
        calls.push(`work:${title}:${workType}:${priority}`);
        return emptyWork(title);
      },
      async createTask(_scope: TodoScope, _workId: string, input: { subject: string }) {
        calls.push(`task:${input.subject}`);
        const work = emptyWork(input.subject);
        work.tasks = [{ id: 1, subject: input.subject, status: "pending", metadata: (input as any).metadata }];
        work.metadata.tasks = work.tasks;
        work.metadata.nextId = 2;
        return work;
      },
    } as unknown as DidaTodoRepository;
    registerTodoTool({ registerTool(value: any) { tool = value; } } as never, repository, () => {});

    await tool.execute("call", {
      action: "create",
      workType: "checklist",
      workPriority: "high",
      subject: "准备更新",
    }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });
    expect(calls).toEqual(["work:准备更新:checklist:5", "task:准备更新"]);

    const result = await tool.execute("call", {
      action: "create",
      workTitle: "升级 CPA 发布链",
      workType: "checklist",
      workPriority: "high",
      subject: "准备更新",
      trackingReason: "multi_step_implementation",
    }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    });

    expect(calls).toEqual(["work:准备更新:checklist:5", "task:准备更新", "task:准备更新"]);
    expect(result.content[0].text).toContain("Created #1");
    expect(result.details.tasks[0]?.metadata?.trackingReason).toBe("multi_step_implementation");
    expect(getSessionRuntime(sessionId)?.work?.remote.id).toBe("remote-work");
    removeSessionRuntime(sessionId);
  });
});
