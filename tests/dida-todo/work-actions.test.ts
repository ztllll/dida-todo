import { describe, expect, it } from "vitest";
import { TODO_WORK_ACTIONS } from "../../extensions/dida-todo/work-tool.js";

describe("LLM 内部工作队列动作", () => {
  it("保留同步、切换、推进和兼容恢复动作", () => {
    expect(TODO_WORK_ACTIONS).toEqual(["list", "switch", "next", "refresh", "finish_current", "acknowledge_feedback", "start_rework"]);
  });
});
