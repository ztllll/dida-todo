export const TODO_QUEUE_CHECK_PHRASE = "检查todo";

export function shouldCheckTodoInput(text: string): boolean {
  return text.trim() === TODO_QUEUE_CHECK_PHRASE;
}
