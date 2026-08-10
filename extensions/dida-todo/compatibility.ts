interface NamedSource {
  name: string;
  source: string;
}

function isDidaTodoSource(source: string): boolean {
  return /(?:^|[\\/])dida-todo(?:[\\/]|$)/.test(source) || source === "dida-todo";
}

export function findDidaTodoConflicts(tools: NamedSource[], commands: NamedSource[]): string[] {
  const conflicts: string[] = [];
  const todo = tools.find((entry) => entry.name === "todo" && !isDidaTodoSource(entry.source));
  if (todo) conflicts.push(`工具 todo 已由 ${todo.source} 注册`);
  const todos = commands.find((entry) => entry.name === "todos" && !isDidaTodoSource(entry.source));
  if (todos) conflicts.push(`命令 /todos 已由 ${todos.source} 注册`);
  return conflicts;
}
