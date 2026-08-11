import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_COMMENT,
  acceptanceMatchesSource,
  buildAcceptanceTaskInput,
  classifyAcceptanceTask,
  formatAcceptanceForAgent,
} from "../../extensions/dida-todo/acceptance.js";
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
      reminders: [
        "TRIGGER:PT0S",
        "TRIGGER:PT2M",
        "TRIGGER:PT4M",
        "TRIGGER:PT6M",
        "TRIGGER:PT8M",
      ],
      tags: ["pi-todo-acceptance"],
    });
    expect(input.content).toContain("实现全文搜索并新增 8 项测试");
    expect(input.content).toContain("如果验收通过，请在滴答中完成此任务");
    expect(input.content).toContain("sourceWorkId: source-work");
  });

  it("重复任务按 occurrence 区分验收，不复用上一次实例", () => {
    const recurring = { ...source, status: 0, repeatFlag: "RRULE:FREQ=DAILY", startDate: "2026-08-11T00:00:00.000+0000" };
    const input = buildAcceptanceTaskInput(recurring, 2, "完成本次实例", new Date("2026-08-11T01:00:00.000Z"));
    const acceptance = { ...source, status: 0, tags: ["pi-todo-acceptance"], content: String(input.content) };

    expect(input.content).toContain("sourceOccurrence: 2026-08-11T00:00:00.000+0000");
    expect(acceptanceMatchesSource(acceptance, recurring)).toBe(true);
    expect(acceptanceMatchesSource(acceptance, { ...recurring, startDate: "2026-08-12T00:00:00.000+0000" })).toBe(false);
    expect(acceptanceMatchesSource({ ...acceptance, content: "sourceWorkId: source-work-10" }, source)).toBe(false);
  });

  it("识别待验收任务但不把它分类为普通工作", () => {
    const acceptance = { ...source, status: 0, tags: ["pi-todo-acceptance"], title: "🧑‍🔬 待验收：实现搜索功能" };
    expect(classifyAcceptanceTask(acceptance)).toBe(true);
    expect(formatAcceptanceForAgent(acceptance, [])).toContain("等待人类验收");
  });

  it("把用户评论作为反馈提供给 LLM，但要求先询问而非擅自返工", () => {
    const acceptance = { ...source, status: 0, tags: ["pi-todo-acceptance"], title: "🧑‍🔬 待验收：实现搜索功能" };
    const text = formatAcceptanceForAgent(acceptance, [
      { id: "system", title: ACCEPTANCE_COMMENT },
      { id: "comment-1", title: "搜索结果排序还不对" },
    ]);
    expect(text).toContain("搜索结果排序还不对");
    expect(text).not.toContain(ACCEPTANCE_COMMENT);
    expect(text).toContain("先向用户确认");
    expect(text).toContain("不代表实现失败");
  });
});
