import { describe, expect, it } from "vitest";
import { TODO_WORK_ACTIONS } from "../../extensions/dida-todo/work-tool.js";

describe("LLM 内部工作队列动作", () => {
  it("只保留同步、切换、推进和完成闭环所需动作", () => {
    expect(TODO_WORK_ACTIONS).toEqual(["list", "switch", "next", "refresh", "finish_current"]);
  });
});
