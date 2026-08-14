import { describe, expect, it } from "bun:test";
import { PUBLIC_DIDA_TODO_COMMANDS } from "../../extensions/dida-todo/commands.js";

describe("Dida Todo 公开命令面", () => {
  it("只保留原 rpiv-todo 的 /todos", () => {
    expect(PUBLIC_DIDA_TODO_COMMANDS).toEqual(["todos"]);
  });
});
