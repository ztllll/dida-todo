import { describe, expect, it } from "vitest";
import { PUBLIC_DIDA_TODO_COMMANDS } from "../../extensions/dida-todo/commands.js";

describe("Dida Todo 公开命令面", () => {
  it("保留 /todos 并新增显式 /dida-bind", () => {
    expect(PUBLIC_DIDA_TODO_COMMANDS).toEqual(["todos", "dida-bind"]);
  });
});
