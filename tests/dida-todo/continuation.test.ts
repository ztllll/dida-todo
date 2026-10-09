import { describe, expect, it } from "vitest";
import { decideContinuation, renderContinuationPrompt } from "../../extensions/dida-todo/continuation.js";

describe("dsh 中断自动续跑决策", () => {
  it("content_filter / 429 / Overloaded / 崩溃中断且有未完成工作时续跑，并逐次退避", () => {
    expect(decideContinuation({ kind: "error", message: "Provider finish_reason: content_filter" }, 0, true))
      .toEqual({ action: "continue", attempt: 1, delayMs: 30_000 });
    expect(decideContinuation({ kind: "interrupted" }, 2, true)).toEqual({ action: "continue", attempt: 3, delayMs: 120_000 });
  });

  it("用户主动停止、正常完成、没有未完成工作时不续跑", () => {
    expect(decideContinuation({ kind: "aborted" }, 0, true).action).toBe("none");
    expect(decideContinuation({ kind: "completed" }, 0, true).action).toBe("none");
    expect(decideContinuation({ kind: "error", message: "Overloaded" }, 0, false).action).toBe("none");
  });

  it("连续续跑用尽后改为通知人类，不再无限重试", () => {
    expect(decideContinuation({ kind: "error", message: "429" }, 5, true)).toEqual({ action: "notify", attempts: 5, lastError: "429" });
  });

  it("content_filter 的续跑提示要求换说法，而不是原样重复", () => {
    const text = renderContinuationPrompt({ kind: "error", message: "Provider finish_reason: content_filter" }, 1, 5, "work");
    expect(text).toContain("do not repeat the last output verbatim");
    expect(text).toContain("wait_for_human");
  });
});
