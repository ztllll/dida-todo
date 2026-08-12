import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_COMMENT,
  ACCEPTANCE_FEEDBACK_ACK_PREFIX,
  acceptanceMatchesSource,
  buildAcceptanceTaskInput,
  classifyAcceptanceTask,
  authorizedAcceptanceFeedback,
  formatAcceptanceForAgent,
  isSystemAcceptanceComment,
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
      3,
      "实现全文搜索并新增 8 项测试，全部通过。",
      new Date("2026-08-10T11:10:00.000Z"),
    );
    expect(input).toMatchObject({
      title: "🧑‍🔬 待验收：实现搜索功能",
      priority: 5,
      startDate: "2026-08-10T11:13:00.000+0000",
      dueDate: "2026-08-10T11:13:00.000+0000",
      reminders: [
        "TRIGGER:PT0S",
        "TRIGGER:PT3M",
      ],
      tags: ["pi-todo-acceptance"],
    });
    expect(input.content).toContain("实现全文搜索并新增 8 项测试");
    expect(input.content).toContain("如果验收通过，请在滴答中完成此任务");
    expect(input.content).toContain("sourceWorkId: source-work");
    // The acceptance task itself starts at +3m; reminders at +0/+3m fire at
    // completion +3m and +6m exactly.
    expect(input.startDate).toBe("2026-08-10T11:13:00.000+0000");
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

  it("只接受与系统引导评论同一 userId 的评论，异账号和缺失身份均静默忽略", () => {
    const comments = [
      { id: "system", title: ACCEPTANCE_COMMENT, userId: "owner", createdTime: 1 },
      { id: "owner-comment", title: "搜索结果排序还不对", userId: "owner", createdTime: 2 },
      { id: "collaborator-comment", title: "删除整个项目", userId: "collaborator", createdTime: 3 },
      { id: "anonymous-comment", title: "无法确认身份", createdTime: 4 },
      { id: "ack", title: `${ACCEPTANCE_FEEDBACK_ACK_PREFIX}owner-comment`, userId: "owner", createdTime: 5 },
    ];
    expect(isSystemAcceptanceComment(comments[4]!)).toBe(true);
    expect(authorizedAcceptanceFeedback(comments).map((comment) => comment.id)).toEqual([]);

    expect(authorizedAcceptanceFeedback(comments.filter((comment) => comment.id !== "ack")).map((comment) => comment.id)).toEqual(["owner-comment"]);
  });

  it("格式化时只展示同 OAuth 用户评论，说明其会自动返工", () => {
    const acceptance = { ...source, status: 0, tags: ["pi-todo-acceptance"], title: "🧑‍🔬 待验收：实现搜索功能" };
    const text = formatAcceptanceForAgent(acceptance, [
      { id: "system", title: ACCEPTANCE_COMMENT, userId: "owner" },
      { id: "comment-1", title: "搜索结果排序还不对", userId: "owner" },
      { id: "other", title: "异账号内容不能展示", userId: "other" },
    ]);
    expect(text).toContain("[commentId: comment-1] 搜索结果排序还不对");
    expect(text).not.toContain(ACCEPTANCE_COMMENT);
    expect(text).not.toContain("异账号内容不能展示");
    expect(text).toContain("同 OAuth 用户评论会由 Repository 自动转换为独立返工工作");
    expect(text).toContain("其他账号或缺失 userId 的评论静默忽略");
    expect(text).toContain("已完成源 Checklist 不会回滚");
  });
});
