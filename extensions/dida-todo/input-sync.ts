export const DIDA_QUEUE_CHECK_PHRASE = "检查todo";
export const DIDA_AUTO_POLL_PREFIX = "自动轮询发现已设置优先级且已到执行时间的 Todo。";

export function shouldCheckTodoInput(text: string): boolean {
  return text.trim() === DIDA_QUEUE_CHECK_PHRASE;
}

export function shouldAcceptAutomaticPollInput(text: string, source: string, runtimeGrant: boolean): boolean {
  return runtimeGrant && source === "extension" && text.startsWith(DIDA_AUTO_POLL_PREFIX);
}
