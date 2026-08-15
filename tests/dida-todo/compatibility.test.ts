import { describe, expect, it } from "vitest";
import { findDidaTodoConflicts } from "../../extensions/dida-todo/compatibility.js";

describe("dida-todo 安装冲突检查", () => {
  it("检测重复的 todo 工具和 /todos 命令", () => {
    const conflicts = findDidaTodoConflicts(
      [
        { name: "read", source: "builtin" },
        { name: "todo", source: "@juicesharp/rpiv-todo" },
        { name: "todo_work", source: "dida-todo" },
      ],
      [
        { name: "todos", source: "@juicesharp/rpiv-todo" },
        { name: "statusline", source: "@narumitw/pi-statusline" },
      ],
    );

    expect(conflicts).toEqual([
      "工具 todo 已由 @juicesharp/rpiv-todo 注册",
      "命令 /todos 已由 @juicesharp/rpiv-todo 注册",
    ]);
  });

  it("忽略 dida-todo 自身和无关工具", () => {
    expect(findDidaTodoConflicts(
      [{ name: "todo", source: "/package/extensions/dida-todo/index.ts" }],
      [{ name: "todos", source: "/package/extensions/dida-todo/index.ts" }],
    )).toEqual([]);
  });
});
