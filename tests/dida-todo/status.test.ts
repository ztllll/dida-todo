import { describe, expect, it } from "bun:test";
import { DIDA_TODO_STATUS_KEYS } from "../../extensions/dida-todo/status.js";

describe("dida-todo 状态栏策略", () => {
  it("不向 Pi 状态栏注册任何 dida-todo 状态", () => {
    expect(DIDA_TODO_STATUS_KEYS).toEqual([]);
  });
});
