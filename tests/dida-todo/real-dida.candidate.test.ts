import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import type { DidaTask, TodoScope, WorkMetadata } from "../../extensions/dida-todo/domain.js";
import { DidaCliGateway } from "../../extensions/dida-todo/gateway.js";
import { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";

const enabled = process.env.DIDA_TODO_REAL_CANDIDATE === "1";
const projectId = process.env.DIDA_TODO_REAL_PROJECT_ID;
const command = process.env.DIDA_TODO_REAL_COMMAND ?? "./node_modules/.bin/dida";
const execFileAsync = promisify(execFile);

async function raw(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd: new URL("../..", import.meta.url).pathname, timeout: 30_000 });
  return stdout.trim();
}

function testName(suffix: string): string {
  return `__dida-todo-v060-candidate-${Date.now()}-${suffix}`;
}

/**
 * Deliberately opt-in live gate. Every task has a unique prefix and is deleted
 * in finally; this test must only target an operator-authorized project.
 */
describe.skipIf(!enabled)("真实 Dida v0.6.0 候选验收（授权当前清单）", () => {
  it("真实 CLI 完成验收、评论、提醒及重复实例推进", async () => {
    expect(projectId, "Set DIDA_TODO_REAL_PROJECT_ID").toMatch(/\S+/);
    const pi = {
      async exec(binary: string, args: string[]) {
        try {
          const { stdout, stderr } = await execFileAsync(binary, args, { cwd: new URL("../..", import.meta.url).pathname, timeout: 30_000 });
          return { code: 0, stdout, stderr, killed: false };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; code?: number };
          return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error), killed: false };
        }
      },
    };
    const gateway = new DidaCliGateway(pi as never, command);
    const scope: TodoScope = {
      binding: { key: "real-candidate", projectId: projectId! },
      bindingKey: "real-candidate",
      cwd: "/isolated-real-candidate",
      sessionId: "real-candidate",
    };
    const createdIds: string[] = [];
    try {
      const metadata: WorkMetadata = {
        schemaVersion: 2,
        kind: "pi-todo-work",
        bindingKey: scope.bindingKey,
        origin: "pi",
        lifecycle: "claimed",
        execution: { claimedAt: new Date().toISOString() },
        nextId: 2,
        tasks: [{ id: 1, subject: "真实验收步骤", status: "completed" }],
      };
      const source = await gateway.createTask({
        projectId,
        title: testName("acceptance"),
        content: encodeManagedContent("real candidate test", metadata),
        priority: 5,
        isAllDay: false,
        startDate: new Date().toISOString(),
        dueDate: new Date().toISOString(),
        timeZone: "UTC",
        reminders: ["TRIGGER:PT2M"],
        tags: ["pi-todo", "pi-todo-real-candidate"],
        items: [{ title: "真实验收步骤", status: 1 }],
      });
      createdIds.push(source.id);
      const work = await new DidaTodoRepository(gateway).getWork(scope, source.id);
      const finalized = await new DidaTodoRepository(gateway).finishWork(scope, work.remote.id);
      createdIds.push(finalized.acceptanceTask.id);
      expect(finalized.acceptanceTask.tags).toContain("pi-todo-acceptance");
      expect(finalized.acceptanceTask.reminders).toEqual(expect.arrayContaining(["TRIGGER:PT0S", "TRIGGER:PT8M"]));
      const comments = await gateway.getTaskComments(projectId!, finalized.acceptanceTask.id);
      expect(comments.some((comment) => comment.title.includes("请在此处输入验收意见"))).toBe(true);
      expect((await gateway.getTask(projectId!, source.id)).status).not.toBe(0);

      const occurrence = new Date();
      occurrence.setUTCHours(0, 0, 0, 0);
      const initialOccurrence = occurrence.toISOString();
      const recurring = await gateway.createTask({
        projectId,
        title: testName("recurring"),
        content: "isolated recurring candidate test",
        priority: 1,
        isAllDay: true,
        startDate: initialOccurrence,
        dueDate: initialOccurrence,
        timeZone: "UTC",
        repeatFlag: "RRULE:FREQ=DAILY",
        tags: ["pi-todo-real-candidate"],
        items: [],
      });
      createdIds.push(recurring.id);
      await gateway.completeTask(projectId!, recurring.id);
      const advanced = await gateway.getTask(projectId!, recurring.id);
      expect(advanced.repeatFlag).toBe("RRULE:FREQ=DAILY");
      expect(advanced.startDate ?? advanced.dueDate).not.toBe(initialOccurrence);
    } finally {
      await Promise.all(createdIds.reverse().map(async (id) => {
        try { await raw(["task", "delete", projectId!, id]); } catch { /* cleanup is best effort after live failure */ }
      }));
    }
  }, 90_000);
});
