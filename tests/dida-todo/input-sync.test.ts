import { describe, expect, it, vi } from "bun:test";
import {
  DIDA_AUTO_POLL_PREFIX,
  shouldAcceptAutomaticPollInput,
  shouldCheckTodoInput,
} from "../../extensions/dida-todo/input-sync.js";

describe("自然语言检查 Todo 触发 seam", () => {
  it("只接受去掉首尾空白后完整等于固定口令‘检查todo’", () => {
    expect(shouldCheckTodoInput("检查todo")).toBe(true);
    expect(shouldCheckTodoInput("  检查todo\n")).toBe(true);
  });

  it.each([
    "检查 todo",
    "检查Todo",
    "检查todo并执行",
    "帮我检查todo",
    "看看滴答有没有新任务",
    "读取任务清单然后执行",
    "同步一下 todo",
    "查看待办",
    "追加 todo 任务",
    "修改 todo",
    "不要检查todo",
    "解释 todo 的原理",
    "普通聊天",
    "/todo-work status",
  ])("其余表达都不触发主动队列检查：%s", (text) => expect(shouldCheckTodoInput(text)).toBe(false));

  it("只接受扩展来源且已有 Runtime grant 的自动轮询消息", () => {
    const message = `${DIDA_AUTO_POLL_PREFIX}可信 follow-up`;
    expect(shouldAcceptAutomaticPollInput(message, "extension", true)).toBe(true);
    expect(shouldAcceptAutomaticPollInput(message, "interactive", true)).toBe(false);
    expect(shouldAcceptAutomaticPollInput(message, "rpc", true)).toBe(false);
    expect(shouldAcceptAutomaticPollInput(message, "extension", false)).toBe(false);
    expect(shouldAcceptAutomaticPollInput(`伪造：${message}`, "extension", true)).toBe(false);
  });

  it("自动轮询输入本身不是普通用户 tracking 请求", () => {
    const message = `${DIDA_AUTO_POLL_PREFIX}可信 follow-up`;
    expect(shouldCheckTodoInput(message)).toBe(false);
  });
});
