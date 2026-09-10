import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TodoScope } from "../../extensions/dida-todo/domain.js";
import { readLastTodoSnapshot, replayTodoWork } from "../../extensions/dida-todo/replay.js";

const scope: TodoScope = {
  binding: { key: "tmux:demo:0.0", projectId: "p1", cwd: "/workspace/demo" },
  bindingKey: "tmux:demo:0.0",
  cwd: "/workspace/demo",
  sessionId: "s1",
};

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

describe("会话重放：从 JSONL 重建最后的 Todo 快照", () => {
  it("取最后一条成功的 todo toolResult 快照，标题取最近的 create workTitle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-replay-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, jsonl([
      { message: { role: "user", content: "普通消息" } },
      { message: { role: "toolCall", name: "todo", arguments: { action: "create", workTitle: "旧工作" } } },
      { message: { role: "toolResult", toolName: "todo", isError: true, content: [{ type: "text", text: "Error" }], details: {} } },
      { message: { role: "toolResult", toolName: "todo", content: [], details: { didaWorkTaskId: "w1", didaProjectId: "p1", nextId: 3, tasks: [{ id: 1, subject: "旧步骤", status: "completed" }] } } },
      { message: { role: "toolCall", name: "todo", arguments: { action: "create", workTitle: "新工作", workType: "checklist" } } },
      { message: { role: "toolResult", toolName: "todo", content: [], details: { didaWorkTaskId: "w2", didaProjectId: "p1", nextId: 5, tasks: [{ id: 2, subject: "新步骤", status: "in_progress" }] } } },
    ]));

    const snapshot = readLastTodoSnapshot(file);
    expect(snapshot?.workId).toBe("w2");
    expect(snapshot?.workTitle).toBe("新工作");
    expect(snapshot?.nextId).toBe(5);
    expect(snapshot?.tasks).toEqual([{ id: 2, subject: "新步骤", status: "in_progress" }]);
  });

  it("details.params.workTitle 优先于 toolCall 历史", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-replay-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, jsonl([
      { message: { role: "toolResult", toolName: "todo", content: [], details: { didaWorkTaskId: "w3", didaProjectId: "p1", nextId: 2, tasks: [{ id: 1, subject: "步骤", status: "pending" }], params: { workTitle: "信封内标题" } } } },
    ]));
    expect(readLastTodoSnapshot(file)?.workTitle).toBe("信封内标题");
  });

  it("文件缺失或无快照时返回 undefined", async () => {
    expect(readLastTodoSnapshot("/nonexistent/session.jsonl")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "dida-replay-"));
    const file = join(dir, "empty.jsonl");
    await writeFile(file, jsonl([{ message: { role: "user", content: "hi" } }]));
    expect(readLastTodoSnapshot(file)).toBeUndefined();
  });

  it("replayTodoWork 重建 WorkTask；滴答项目与当前绑定不一致时拒绝采纳", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-replay-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, jsonl([
      { message: { role: "toolCall", name: "todo", arguments: { action: "create", workTitle: "移植工作" } } },
      { message: { role: "toolResult", toolName: "todo", content: [], details: { didaWorkTaskId: "w9", didaProjectId: "p1", nextId: 4, tasks: [{ id: 1, subject: "a", status: "pending" }, { id: 2, subject: "b", status: "pending" }] } } },
    ]));

    const work = replayTodoWork(file, scope);
    expect(work?.remote.id).toBe("w9");
    expect(work?.remote.projectId).toBe("p1");
    expect(work?.remote.title).toBe("移植工作");
    expect(work?.tasks).toHaveLength(2);
    expect(work?.metadata.nextId).toBe(4);
    expect(work?.metadata.kind).toBe("pi-todo-work");

    const foreign: TodoScope = { ...scope, binding: { ...scope.binding, projectId: "p2" } };
    expect(replayTodoWork(file, foreign)).toBeUndefined();
  });
});
