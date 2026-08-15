import { describe, expect, it } from "vitest";
import {
  AcceptanceResultUpdater,
  buildAcceptanceResultUpdate,
  extractFinalAssistantResponse,
} from "../../extensions/dida-todo/acceptance-result.js";
import type { DidaTask } from "../../extensions/dida-todo/domain.js";
import { MemoryWorkStateStore } from "../../extensions/dida-todo/state-store.js";

const source: DidaTask = {
  id: "source",
  projectId: "project",
  title: "实现搜索功能",
  status: 2,
  priority: 3,
  startDate: "2026-08-12T00:00:00.000+0000",
  dueDate: "2026-08-12T00:00:00.000+0000",
  timeZone: "Asia/Shanghai",
};

const acceptance: DidaTask = {
  id: "acceptance",
  projectId: "project",
  title: "🧑‍🔬 待验收：实现搜索功能",
  content: "占位报告\nsourceWorkId: source",
  desc: "占位报告",
  status: 0,
  priority: 3,
  startDate: "2026-08-12T00:03:00.000+0000",
  dueDate: "2026-08-12T00:03:00.000+0000",
  timeZone: "Asia/Shanghai",
  reminders: ["TRIGGER:PT0S", "TRIGGER:PT3M"],
  tags: ["pi-todo-acceptance"],
  items: [],
};

describe("待验收最终回复回填", () => {
  it("只提取最后一条无工具调用的成功助手文本", () => {
    const text = extractFinalAssistantResponse([
      {
        role: "assistant",
        content: [
          { type: "text", text: "先调用工具" },
          { type: "toolCall", id: "call", name: "todo", arguments: {} },
        ],
        stopReason: "toolUse",
      },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "内部思考不能写入" },
          { type: "text", text: "**全文搜索优化已完成**\n\n- 新增排序\n- 12 项测试通过" },
        ],
        stopReason: "stop",
      },
    ]);

    expect(text).toBe("**全文搜索优化已完成**\n\n- 新增排序\n- 12 项测试通过");
  });

  it("最后助手消息为错误、终止或工具调用时不回退到更早计划文本", () => {
    expect(extractFinalAssistantResponse([
      { role: "assistant", content: [{ type: "text", text: "更早计划文本" }], stopReason: "stop" },
      { role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }], stopReason: "toolUse" },
    ])).toBeUndefined();
    expect(extractFinalAssistantResponse([
      { role: "assistant", content: [{ type: "text", text: "失败文本" }], stopReason: "error" },
    ])).toBeUndefined();
  });

  it("用真实最终回复更新标题、描述和详细内容，并保留调度字段", () => {
    const finalResponse = "**全文搜索优化已完成**\n\n- 新增相关性排序\n- 12 项测试全部通过";
    const update = buildAcceptanceResultUpdate(source, acceptance, finalResponse);

    expect(update).toMatchObject({
      id: "acceptance",
      projectId: "project",
      title: "🧑‍🔬 待验收：全文搜索优化已完成",
      desc: finalResponse,
      priority: 3,
      startDate: acceptance.startDate,
      dueDate: acceptance.dueDate,
      timeZone: "Asia/Shanghai",
      reminders: ["TRIGGER:PT0S", "TRIGGER:PT3M"],
      tags: ["pi-todo-acceptance"],
      items: [],
    });
    expect(String(update.content)).toContain("## 完成结果\n" + finalResponse);
    expect(String(update.content)).not.toContain("sourceWorkId:");
    expect(String(update.content)).toContain("如果验收通过");
    expect(String(update.content)).not.toContain("占位报告");
  });

  it("通过本机状态关联定位干净的同源验收并保真更新", async () => {
    const cleanAcceptance = { ...acceptance, content: "等待验收的干净报告" };
    const stateStore = new MemoryWorkStateStore();
    await stateStore.setAcceptance("project", "acceptance", { sourceWorkId: "source" });
    const updates: Array<{ id: string; input: Record<string, unknown> }> = [];
    const updater = new AcceptanceResultUpdater({
      async getProjectData() { return { tasks: [cleanAcceptance] }; },
      async updateTask(id, input) { updates.push({ id, input }); return { ...cleanAcceptance, ...input } as DidaTask; },
    }, stateStore);
    const result = await updater.update({
      binding: { key: "binding", projectId: "project" },
      bindingKey: "binding",
      cwd: "/workspace",
      sessionId: "session",
    }, source, "搜索结果已交付\n- 测试通过");

    expect(result?.title).toBe("🧑‍🔬 待验收：搜索结果已交付");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe("acceptance");
  });

  it("历史 metadata 缺少原始描述时从源任务恢复且正文只出现一次", async () => {
    const combinedSource: DidaTask = {
      ...source,
      desc: "用户描述\n\n稳定正文\n\n当前进展：旧实验状态\n已处理 1/1 项\n\n稳定正文",
    };
    const cleanAcceptance = { ...acceptance, content: "等待验收的干净报告" };
    const stateStore = new MemoryWorkStateStore();
    await stateStore.set("project", "source", {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "binding",
      origin: "pi",
      lifecycle: "finalized",
      workType: "checklist",
      userContent: "稳定正文",
      execution: { claimedAt: "2026-08-15T00:00:00.000Z" },
      nextId: 2,
      tasks: [{ id: 1, subject: "完成测试", status: "completed", metadata: { resolution: "通过" } }],
    });
    await stateStore.setAcceptance("project", "acceptance", { sourceWorkId: "source" });
    const updater = new AcceptanceResultUpdater({
      async getProjectData() { return { tasks: [cleanAcceptance] }; },
      async updateTask(_id, input) { return { ...cleanAcceptance, ...input } as DidaTask; },
    }, stateStore);

    const result = await updater.update({
      binding: { key: "binding", projectId: "project" }, bindingKey: "binding", cwd: "/workspace", sessionId: "session",
    }, combinedSource, "最终回复");

    expect(result?.desc).toContain("任务说明：\n用户描述");
    expect(result?.desc).toContain("补充内容：\n稳定正文");
    expect(result?.desc?.split("稳定正文")).toHaveLength(2);
    expect(result?.desc).not.toContain("当前进展：");
  });

  it("找不到同源未完成验收时静默跳过", async () => {
    let updated = false;
    const updater = new AcceptanceResultUpdater({
      async getProjectData() { return { tasks: [{ ...acceptance, status: 2 }] }; },
      async updateTask() { updated = true; return acceptance; },
    });
    const result = await updater.update({
      binding: { key: "binding", projectId: "project" }, bindingKey: "binding", cwd: "/workspace", sessionId: "session",
    }, source, "完成");
    expect(result).toBeUndefined();
    expect(updated).toBe(false);
  });

  it("多工作共享最终回复时可保留各自源任务标题", () => {
    const update = buildAcceptanceResultUpdate(source, acceptance, "整个队列已完成", { deriveTitle: false });
    expect(update.title).toBe("🧑‍🔬 待验收：实现搜索功能");
    expect(update.desc).toBe("整个队列已完成");
  });

  it("标题清洗 Markdown 并限制长度，空结果回退源任务标题", () => {
    const long = `## ${"结果".repeat(80)}\n正文`;
    const update = buildAcceptanceResultUpdate(source, acceptance, long);
    expect(String(update.title)).toMatch(/^🧑‍🔬 待验收：结果/);
    expect(String(update.title).length).toBeLessThanOrEqual(100);
    expect(buildAcceptanceResultUpdate(source, acceptance, "   ").title).toBe("🧑‍🔬 待验收：实现搜索功能");
  });
});
