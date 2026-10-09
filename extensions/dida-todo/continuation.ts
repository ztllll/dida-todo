// dsh 会话中断后的自动续跑决策（纯逻辑，宿主无关，便于测试）。
//
// dsh 实测：模型返回 content_filter / 429 / Overloaded / 进程崩溃时 turn 以
// error|interrupted 结束，agent 回到 idle 后不会自己继续，必须人手输入“继续”。
// 本模块决定：哪些结束原因值得自动续跑、退避多久、连续失败几次后改为通知人类。

export type TurnEndKind = "completed" | "error" | "interrupted" | "aborted" | "max-tokens" | "blocked" | "forked" | string;

export interface TurnEnd {
  kind: TurnEndKind;
  message?: string;
}

export interface ContinuationPolicy {
  /** 连续自动续跑次数上限；用尽后停止续跑并通知人类。 */
  maxAttempts: number;
  /** 第 n 次续跑前的等待（毫秒），超出数组长度取最后一个。 */
  backoffMs: number[];
}

export const DEFAULT_CONTINUATION_POLICY: ContinuationPolicy = {
  maxAttempts: 5,
  backoffMs: [30_000, 60_000, 120_000, 300_000, 600_000],
};

export type ContinuationDecision =
  | { action: "none"; reason: string }
  | { action: "continue"; attempt: number; delayMs: number }
  | { action: "notify"; attempts: number; lastError: string };

/** 只有“可恢复的意外中断”才续跑：用户主动停止、正常完成、被拦截都不续跑。 */
export function isRecoverableTurnEnd(end: TurnEnd): boolean {
  return end.kind === "error" || end.kind === "interrupted";
}

export function decideContinuation(
  end: TurnEnd,
  previousAttempts: number,
  hasOpenWork: boolean,
  policy: ContinuationPolicy = DEFAULT_CONTINUATION_POLICY,
): ContinuationDecision {
  if (!isRecoverableTurnEnd(end)) return { action: "none", reason: `turn ended: ${end.kind}` };
  if (!hasOpenWork) return { action: "none", reason: "no open dida work in this session" };
  if (previousAttempts >= policy.maxAttempts) {
    return { action: "notify", attempts: previousAttempts, lastError: end.message ?? end.kind };
  }
  const attempt = previousAttempts + 1;
  const delayMs = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 60_000;
  return { action: "continue", attempt, delayMs };
}

/** content_filter 多半由上一步内容触发，原样“继续”会再次被拦，提示模型换个说法。 */
export function renderContinuationPrompt(end: TurnEnd, attempt: number, maxAttempts: number, workSummary: string): string {
  const filtered = /content_filter/i.test(end.message ?? "");
  return [
    `[DIDA-TODO AUTO-CONTINUE ${attempt}/${maxAttempts}]`,
    `The previous turn stopped unexpectedly (${end.kind}${end.message ? `: ${end.message.slice(0, 160)}` : ""}). The human is not watching; continue the unfinished work below from where it stopped.`,
    filtered
      ? "The stop was a provider content filter: do not repeat the last output verbatim; rephrase, summarize large tool output instead of quoting it, and keep going."
      : "Re-check the current state (files, command output, todo list) before repeating any action, then keep going.",
    "If the work genuinely needs a human decision, call todo_work wait_for_human with the reason instead of stopping silently.",
    "",
    workSummary,
  ].join("\n");
}
