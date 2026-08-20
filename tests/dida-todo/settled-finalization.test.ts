import { describe, expect, it } from "vitest";
import type { TodoScope, WorkTask } from "../../extensions/dida-todo/domain.js";
import type { DidaTodoRepository } from "../../extensions/dida-todo/repository.js";
import { finalizeWorkAtSettlement } from "../../extensions/dida-todo/settled-finalization.js";

const scope: TodoScope = {
  binding: { key: "binding", projectId: "project" },
  bindingKey: "binding",
  cwd: "/workspace",
  sessionId: "session",
};

function work(statuses: Array<"pending" | "completed" | "skipped">, workType: "direct" | "checklist" = "direct"): WorkTask {
  const tasks = statuses.map((status, index) => ({ id: index + 1, subject: `步骤${index + 1}`, status }));
  return {
    remote: { id: "work", projectId: "project", title: "完整用户请求", status: 0, priority: 1 },
    userContent: "",
    tasks,
    metadata: {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "binding",
      origin: "pi",
      lifecycle: "claimed",
      workType,
      execution: { claimedAt: "2026-08-13T00:00:00.000Z" },
      nextId: tasks.length + 1,
      tasks,
    },
  };
}

describe("Agent settled 收口边界", () => {
  it("只在 settled 时收口全部完成工作，并返回 status=2 的 Runtime 工作", async () => {
    const current = work(["completed"]);
    const completed: string[] = [];
    const repository = {
      async getWork() { return structuredClone(current); },
      async finishWork(_scope: TodoScope, workId: string) { completed.push(workId); return { acceptanceTask: {} }; },
    } as unknown as DidaTodoRepository;

    const result = await finalizeWorkAtSettlement(repository, scope, "work");

    expect(result.state).toBe("finalized");
    expect(result.work.remote.status).toBe(2);
    expect(completed).toEqual(["work"]);
  });

  it("用户在滴答创建的 Checklist Items 全完成后，settled 自动结束顶层", async () => {
    const current = work(["completed", "completed"], "checklist");
    current.metadata = { ...current.metadata, origin: "dida" } as WorkTask["metadata"];
    const completed: string[] = [];
    const repository = {
      async getWork() { return structuredClone(current); },
      async finishWork(_scope: TodoScope, workId: string) { completed.push(workId); return { acceptanceTask: {} }; },
    } as unknown as DidaTodoRepository;

    const result = await finalizeWorkAtSettlement(repository, scope, "work");

    expect(result.state).toBe("finalized");
    expect(result.work.remote.status).toBe(2);
    expect(completed).toEqual(["work"]);
  });

  it("用户明确要求保持顶层未完成时，settled 不因 completed + skipped 自动收口", async () => {
    const current = work(["completed", "skipped"], "checklist");
    current.metadata = { ...current.metadata, origin: "dida", keepOpen: true } as WorkTask["metadata"];
    let finishCalls = 0;
    const repository = {
      async getWork() { return structuredClone(current); },
      async finishWork() { finishCalls += 1; return { acceptanceTask: {} }; },
    } as unknown as DidaTodoRepository;

    const result = await finalizeWorkAtSettlement(repository, scope, "work");

    expect(result.state).toBe("not-ready");
    expect(result.work.remote.status).toBe(0);
    expect(finishCalls).toBe(0);
  });

  it("Checklist 的全部 Items 完成后，settled 自动完成顶层任务", async () => {
    const current = work(["completed", "completed"], "checklist");
    let finishCalls = 0;
    const repository = {
      async getWork() { return structuredClone(current); },
      async finishWork() { finishCalls += 1; return { acceptanceTask: {} }; },
    } as unknown as DidaTodoRepository;

    const result = await finalizeWorkAtSettlement(repository, scope, "work");

    expect(result.state).toBe("finalized");
    expect(result.work.remote.status).toBe(2);
    expect(finishCalls).toBe(1);
  });

  it("如果同一 turn 后续追加 pending 步骤，则 settled 不创建验收", async () => {
    const current = work(["completed", "pending"]);
    let finishCalls = 0;
    const repository = {
      async getWork() { return structuredClone(current); },
      async finishWork() { finishCalls += 1; return { acceptanceTask: {} }; },
    } as unknown as DidaTodoRepository;

    const result = await finalizeWorkAtSettlement(repository, scope, "work");

    expect(result.state).toBe("not-ready");
    expect(result.work.remote.status).toBe(0);
    expect(finishCalls).toBe(0);
  });
});
