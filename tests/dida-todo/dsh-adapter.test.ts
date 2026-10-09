import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../extensions/dsh/index.js";
import type { WorkTask } from "../../extensions/dida-todo/domain.js";
import { removeSessionRuntime } from "../../extensions/dida-todo/runtime.js";

// dsh 适配层冒烟：假 dsh 上下文 + 假仓库，跑通 绑定 → 工具 → 中断续跑 → 用户接手撤销 → 用尽转提醒。
function work(): WorkTask {
  const tasks = [{ id: 1, subject: "第一步", status: "pending" as const }, { id: 2, subject: "第二步", status: "pending" as const }];
  return {
    remote: { id: "w1", projectId: "proj", title: "大任务", status: 0, priority: 3 },
    userContent: "",
    tasks,
    metadata: { schemaVersion: 2, kind: "pi-todo-work", bindingKey: "cwd:/work", origin: "dida", lifecycle: "claimed", workType: "checklist", nextId: 3, tasks },
  };
}

function harness() {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools: any[] = [];
  const sent: string[] = [];
  const paused: string[] = [];
  const appended: Array<{ type: string; data: any }> = [];
  const agent = {
    id: "s1",
    status: "idle" as "idle" | "running",
    session: { id: "s1", header: { cwd: "/work" }, append(type: string, data: unknown) { appended.push({ type, data }); } },
    followup(message: { content: Array<{ text: string }> }) { sent.push(message.content[0]!.text); },
  };
  const ctx = {
    agents: { get: (id: string) => (id === "s1" ? agent : undefined), list: () => [agent], withoutInitiator: <T>(op: () => T) => op() },
    tools: { register(def: unknown) { tools.push(def); return () => {}; } },
    on(event: string, fn: (...args: any[]) => unknown) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => {}; },
    effect(factory: () => () => void) { factory(); },
  };
  const repository = {
    async syncOpenWorks() { return { works: [work()], adoptedWorkIds: [], acceptances: [], finalizationFailures: [] }; },
    async waitForHuman(_scope: unknown, workId: string, reason: string) { paused.push(reason); return { ...work(), remote: { ...work().remote, id: workId, priority: 0 } }; },
  };
  const emit = async (event: string, ...args: unknown[]) => { for (const fn of listeners.get(event) ?? []) await fn(...args); };
  const turnEnd = (kind: string, message?: string) => emit("session/event", agent.session, { type: "turn/end", data: { reason: { kind, ...(message ? { error: { message } } : {}) } } });
  return { ctx, tools, sent, paused, agent, emit, turnEnd, repository, appended };
}

afterEach(() => { vi.useRealTimers(); removeSessionRuntime("s1"); });

describe("dsh 宿主插件", () => {
  it("注册 todo/todo_work，按会话 cwd 绑定滴答清单", async () => {
    const h = harness();
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [{ key: "cwd:/work", projectId: "proj", cwd: "/work" }] }, repository: h.repository as never } });
    expect(h.tools.map((tool) => tool.name)).toEqual(["todo", "todo_work"]);
    await vi.waitFor(async () => {
      expect(await h.tools[0].execute({ action: "list" }, { agent: h.agent })).toContain("第一步");
    });
  });

  it("todo 工具调用后把滴答 Checklist 写成 dsh todo/write，显示在 dsh 自带 Todo 面板", async () => {
    const h = harness();
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [{ key: "cwd:/work", projectId: "proj", cwd: "/work" }] }, repository: h.repository as never } });
    await vi.waitFor(async () => expect(await h.tools[0].execute({ action: "list" }, { agent: h.agent })).toContain("第一步"));
    const last = h.appended.filter((event) => event.type === "todo/write").at(-1);
    expect(last?.data.todos).toEqual([{ content: "第一步", status: "pending" }, { content: "第二步", status: "pending" }]);
  });

  it("content_filter 中断后自动续跑；人手发消息后撤销待发续跑", async () => {
    const h = harness();
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [{ key: "cwd:/work", projectId: "proj", cwd: "/work" }] }, repository: h.repository as never } });
    await vi.waitFor(async () => expect(await h.tools[0].execute({ action: "list" }, { agent: h.agent })).toContain("第一步"));
    vi.useFakeTimers();
    await h.turnEnd("error", "Provider finish_reason: content_filter");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("AUTO-CONTINUE 1/5");

    await h.turnEnd("error", "Overloaded");
    await h.emit("agent/inbox/inserted", { agent: h.agent, message: { id: "m", content: [{ type: "text", text: "我来看看" }], source: { kind: "user" } } });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sent).toHaveLength(1);
  });

  it("连续中断用尽续跑次数后转为滴答提醒；用户主动停止不续跑", async () => {
    const h = harness();
    await apply(h.ctx as never, { poll: false, maxAutoContinue: 2, testOverrides: { config: { bindings: [{ key: "cwd:/work", projectId: "proj", cwd: "/work" }] }, repository: h.repository as never } });
    await vi.waitFor(async () => expect(await h.tools[0].execute({ action: "list" }, { agent: h.agent })).toContain("第一步"));
    vi.useFakeTimers();
    await h.turnEnd("aborted");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sent).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) {
      await h.turnEnd("error", "429");
      await vi.advanceTimersByTimeAsync(600_000);
    }
    expect(h.sent).toHaveLength(2);
    await h.turnEnd("error", "429");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sent).toHaveLength(2);
    expect(h.paused[0]).toContain("连续 2 次自动续跑后仍中断");
  });

  it("dsh 原生 goal 中断（未绑定滴答工作）：重新激活 goal 并续跑", async () => {
    const h = harness();
    const resumed: string[] = [];
    const goal = { id: "g1", revision: 3, phase: "active", activation: "disarmed", roundsStarted: 4, maxGoalRounds: 256 };
    const services: Record<string, unknown> = {
      goals: { get: () => goal, resume: (_agent: unknown, ref: { id: string }) => { resumed.push(ref.id); return { ...goal, activation: "armed" }; } },
    };
    (h.ctx as Record<string, unknown>).get = (name: string) => services[name];
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [] }, repository: h.repository as never } });
    await h.emit("session/event", h.agent.session, { type: "todo/write", data: { todos: [{ content: "报告给老板", status: "in_progress" }] } });
    vi.useFakeTimers();
    await h.turnEnd("error", "Provider finish_reason: content_filter");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resumed).toEqual(["g1"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("报告给老板");
  });

  it("会话没碰过的滴答工作不算本会话未完成工作：中断不续跑", async () => {
    const h = harness();
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [{ key: "cwd:/work", projectId: "proj", cwd: "/work" }] }, repository: h.repository as never } });
    await h.emit("agent/created", { agent: h.agent });
    await vi.waitFor(() => expect(h.ctx.agents.list()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    vi.useFakeTimers();
    await h.turnEnd("error", "Provider finish_reason: content_filter");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sent).toHaveLength(0);
  });

  it("dsh 重启后恢复的会话：上一回合 interrupted 且有未完成 todo_write，接管时自动续跑", async () => {
    const h = harness();
    const now = Date.now();
    (h.agent.session as Record<string, unknown>).ownEvents = () => [
      { type: "turn/start", time: now - 60_000 },
      { type: "todo/write", time: now - 50_000, data: { todos: [{ content: "同步交接文档", status: "in_progress" }] } },
      { type: "turn/end", time: now - 10_000, data: { reason: { kind: "interrupted" } } },
    ];
    vi.useFakeTimers({ now });
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [] }, repository: h.repository as never } });
    await h.emit("agent/created", { agent: h.agent });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("同步交接文档");
  });

  it("恢复的会话上一回合正常完成或早已过时，不续跑", async () => {
    const h = harness();
    const now = Date.now();
    (h.agent.session as Record<string, unknown>).ownEvents = () => [
      { type: "todo/write", time: now - 3_600_000, data: { todos: [{ content: "旧任务", status: "pending" }] } },
      { type: "turn/end", time: now - 3_600_000, data: { reason: { kind: "interrupted" } } },
    ];
    vi.useFakeTimers({ now });
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [] }, repository: h.repository as never } });
    await h.emit("agent/created", { agent: h.agent });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sent).toHaveLength(0);
  });

  it("未绑定目录的会话不接管、工具给出绑定指引", async () => {
    const h = harness();
    await apply(h.ctx as never, { poll: false, testOverrides: { config: { bindings: [] }, repository: h.repository as never } });
    await h.emit("agent/created", { agent: h.agent });
    await expect(h.tools[0].execute({ action: "list" }, { agent: h.agent })).rejects.toThrow("未绑定滴答清单");
  });
});
