import { describe, expect, it } from "bun:test";
import { DIDA_TODO_WORK_ACTIONS } from "../../extensions/dida-todo/work-tool.js";

describe("LLM 内部工作队列动作", () => {
  it("保留同步、切换、推进和兼容恢复动作", () => {
    expect(DIDA_TODO_WORK_ACTIONS).toEqual(["list", "switch", "next", "refresh", "finish_current"]);
  });
});
