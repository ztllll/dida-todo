const POSITIVE_PATTERNS = [
  /检查\s*(?:一下\s*)?(?:todo|待办|任务清单|滴答任务)/i,
  /(?:看看|查看|读取|拉取|同步)\s*(?:一下\s*)?(?:滴答|todo|待办|任务清单)/i,
  /(?:滴答|todo|待办|任务清单).*(?:有没有|是否有|新任务|执行)/i,
];

export function shouldCheckTodoInput(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("/")) return false;
  if (/不要|无需|不用|别/.test(normalized) && /检查|同步|读取|查看/.test(normalized)) return false;
  return POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}
