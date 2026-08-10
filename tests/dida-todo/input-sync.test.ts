import { describe, expect, it, vi } from "vitest";
import { shouldCheckTodoInput } from "../../extensions/dida-todo/input-sync.js";

describe("自然语言检查 Todo 触发 seam", () => {
  it.each([
    "检查todo",
    "检查 todo",
    "看看滴答有没有新任务",
    "读取任务清单然后执行",
    "同步一下 todo",
    "查看待办",
  ])("识别：%s", (text) => expect(shouldCheckTodoInput(text)).toBe(true));

  it.each(["解释 todo 的原理", "不要检查任务", "普通聊天", "/todo-work status"])("不误触发：%s", (text) =>
    expect(shouldCheckTodoInput(text)).toBe(false),
  );
});
