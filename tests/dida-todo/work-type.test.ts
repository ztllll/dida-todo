import { describe, expect, it } from "vitest";
import { metadataToItems } from "../../extensions/dida-todo/codec.js";
import type { DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { createPiWorkMetadata } from "../../extensions/dida-todo/work-lifecycle.js";
import { inferWorkType, workTypeOfMetadata } from "../../extensions/dida-todo/work-type.js";

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace",
  sessionId: "session",
};

function metadata(workType: "direct" | "checklist"): WorkMetadata {
  return {
    ...createPiWorkMetadata(scope, workType),
    nextId: 2,
    tasks: [{ id: 1, subject: "内部执行步骤", status: "pending" }],
  };
}

describe("滴答直接任务与 Checklist 工作类型", () => {
  it("根据远端形态区分直接任务和 Checklist 任务", () => {
    const direct: DidaTask = { id: "d", projectId: "p", title: "直接", status: 0, priority: 1, kind: "TEXT" };
    const checklist: DidaTask = { id: "c", projectId: "p", title: "大任务", status: 0, priority: 1, kind: "CHECKLIST", items: [] };
    expect(inferWorkType(direct)).toBe("direct");
    expect(inferWorkType(checklist)).toBe("checklist");
  });

  it("直接任务的内部步骤不写成滴答 Checklist Items", () => {
    expect(metadataToItems(metadata("direct"))).toEqual([]);
  });

  it("Checklist 工作把步骤写成可勾选 Items", () => {
    expect(metadataToItems(metadata("checklist"))).toEqual([
      expect.objectContaining({ title: "内部执行步骤", status: 0 }),
    ]);
  });

  it("显式 workType 优先于远端历史 kind", () => {
    const remote: DidaTask = { id: "w", projectId: "p", title: "工作", status: 0, priority: 1, kind: "CHECKLIST", items: [] };
    expect(workTypeOfMetadata(metadata("direct"), remote)).toBe("direct");
  });
});
