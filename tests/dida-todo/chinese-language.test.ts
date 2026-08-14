import { describe, expect, it } from "bun:test";
import { requireChineseCreationText, type TodoParams } from "../../extensions/dida-todo/tool.js";

function createParams(overrides: Partial<TodoParams>): TodoParams {
  return { action: "create", subject: "创建滴答任务", ...overrides };
}

describe("Dida Todo 创建语言策略", () => {
  it("默认拒绝没有中文语义的每个已填写创建字段", () => {
    expect(() => requireChineseCreationText(createParams({ subject: "Ship release" }))).toThrow("subject 必须用中文表达");
    expect(() => requireChineseCreationText(createParams({ workTitle: "Release work" }))).toThrow("workTitle 必须用中文表达");
    expect(() => requireChineseCreationText(createParams({ workDescription: "Prepare deployment" }))).toThrow("workDescription 必须用中文表达");
    expect(() => requireChineseCreationText(createParams({ workContent: "Run smoke tests" }))).toThrow("workContent 必须用中文表达");
    expect(() => requireChineseCreationText(createParams({ description: "Verify rollback" }))).toThrow("description 必须用中文表达");
  });

  it("允许中文动作包围的专有名词与代码标识", () => {
    expect(() => requireChineseCreationText(createParams({
      subject: "发布 OMP v0.7.0",
      workDescription: "验证 dida_todo 的 smoke test",
    }))).not.toThrow();
  });

  it("只有显式 allowNonChinese 才允许非中文创建内容", () => {
    expect(() => requireChineseCreationText(createParams({
      subject: "Ship release",
      allowNonChinese: true,
    }))).not.toThrow();
  });
});
