import { describe, expect, it } from "vitest";
import { buildAcceptanceTaskInput, classifyAcceptanceTask, formatAcceptanceForAgent } from "../../extensions/dida-todo/acceptance.js";
import type { DidaTask } from "../../extensions/dida-todo/domain.js";

const source: DidaTask = {
  id: "source-work",
  projectId: "project",
  title: "实现搜索功能",
  status: 2,
  priority: 5,
  timeZone: "Asia/Shanghai",
};

describe("人类验收闭环", () => {
  it("创建包含汇总和操作说明的待验收任务", () => {
    const input = buildAcceptanceTaskInput(
      source,
      2,
      "实现全文搜索并新增 8 项测试，全部通过。",
      new Date("2026-08-10T11:10:00.000Z"),
    );
    expect(input).toMatchObject({
      title: "🧑‍🔬 待验收：实现搜索功能",
      priority: 5,
      startDate: "2026-08-10T11:12:00.000+0000",
      dueDate: "2026-08-10T11:12:00.000+0000",
      reminders: ["TRIGGER:PT0S"],
      tags: ["pi-todo-acceptance"],
    });
    expect(input.content).toContain("实现全文搜索并新增 8 项测试");
    expect(input.content).toContain("如果验收通过，请在滴答中完成此任务");
    expect(input.content).toContain("sourceWorkId: source-work");
  });

  it("识别待验收任务但不把它分类为普通工作", () => {
    const acceptance = { ...source, status: 0, tags: ["pi-todo-acceptance"], title: "🧑‍🔬 待验收：实现搜索功能" };
    expect(classifyAcceptanceTask(acceptance)).toBe(true);
    expect(formatAcceptanceForAgent(acceptance, [])).toContain("等待人类验收");
  });

  it("把用户评论作为反馈提供给 LLM，但要求先询问而非擅自返工", () => {
    const acceptance = { ...source, status: 0, tags: ["pi-todo-acceptance"], title: "🧑‍🔬 待验收：实现搜索功能" };
    const text = formatAcceptanceForAgent(acceptance, [
      { id: "comment-1", title: "搜索结果排序还不对" },
    ]);
    expect(text).toContain("搜索结果排序还不对");
    expect(text).toContain("先向用户确认");
    expect(text).toContain("不代表实现失败");
  });
});
