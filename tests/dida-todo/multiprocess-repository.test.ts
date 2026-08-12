import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodeManagedContent } from "../../extensions/dida-todo/codec.js";
import type { DidaTask, WorkMetadata } from "../../extensions/dida-todo/domain.js";

const repositoryModule = resolve(import.meta.dirname, "../../extensions/dida-todo/repository.ts");

function run(worker: string, store: string, action: "complete-item" | "finish", id?: number): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["./node_modules/vite-node/vite-node.mjs", worker, store, action, ...(id ? [String(id)] : [])], {
      cwd: resolve(import.meta.dirname, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

function source(metadata: WorkMetadata, items: DidaTask["items"]): DidaTask {
  return {
    id: "work",
    projectId: "project",
    title: "并发工作",
    status: 0,
    priority: 5,
    content: encodeManagedContent("", metadata),
    items,
  };
}

const workerSource = (repositoryPath: string) => [
  'import { readFile, writeFile } from "node:fs/promises";',
  `import { DidaTodoRepository } from ${JSON.stringify(repositoryPath)};`,
  "const [store, action, id] = process.argv.slice(2);",
  "const load = async () => JSON.parse(await readFile(store, 'utf8'));",
  "const save = async (value) => writeFile(store, JSON.stringify(value));",
  "class Gateway {",
  "  async getProjectData(projectId) { const data = await load(); return { project: { id: projectId, name: 'test' }, tasks: data.tasks.filter((task) => task.status === 0), columns: [] }; }",
  "  async getTask(_projectId, taskId) { const data = await load(); const task = data.tasks.find((item) => item.id === taskId); if (!task) throw new Error('not found'); return structuredClone(task); }",
  "  async updateTask(taskId, input) { const data = await load(); const index = data.tasks.findIndex((task) => task.id === taskId); const current = data.tasks[index]; data.tasks[index] = { ...current, ...structuredClone(input), id: taskId, items: (input.items ?? current.items).map((item, index) => ({ ...item, id: item.id ?? `item-${index}` })) }; await save(data); return structuredClone(data.tasks[index]); }",
  "  async createTask(input) { const data = await load(); const task = { ...structuredClone(input), id: `acceptance-${data.created++}`, status: 0, priority: Number(input.priority ?? 0) }; data.tasks.push(task); await save(data); return structuredClone(task); }",
  "  async completeTask(_projectId, taskId) { const data = await load(); const task = data.tasks.find((item) => item.id === taskId); task.status = 2; data.completes = (data.completes ?? 0) + 1; await save(data); }",
  "  async addTaskComment() {} async getTaskComments() { return []; }",
  "}",
  "const scope = { binding: { key: 'tmux:demo:0.0', projectId: 'project' }, bindingKey: 'tmux:demo:0.0', cwd: '/workspace/demo', sessionId: `child-${process.pid}` };",
  "const repository = new DidaTodoRepository(new Gateway());",
  "if (action === 'complete-item') await repository.updateTask(scope, 'work', Number(id), { status: 'completed' }); else await repository.finishWork(scope, 'work');",
].join("\n");

describe("同宿主多进程 Repository seam", () => {
  it("两个进程完成不同 Checklist 时锁内重读并保留两次更新", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dida-multiprocess-work-"));
    const store = join(directory, "store.json");
    const worker = join(directory, "worker.ts");
    const metadata: WorkMetadata = {
      schemaVersion: 2, kind: "pi-todo-work", bindingKey: "tmux:demo:0.0", origin: "pi", lifecycle: "claimed",
      execution: { claimedAt: "2026-08-11T00:00:00.000Z" }, nextId: 3,
      tasks: [{ id: 1, subject: "步骤一", itemId: "one", status: "pending" }, { id: 2, subject: "步骤二", itemId: "two", status: "pending" }],
    };
    await writeFile(store, JSON.stringify({ created: 1, tasks: [source(metadata, [{ id: "one", title: "步骤一", status: 0 }, { id: "two", title: "步骤二", status: 0 }])] }));
    await writeFile(worker, workerSource(repositoryModule));
    try {
      await Promise.all([run(worker, store, "complete-item", 1), run(worker, store, "complete-item", 2)]);
      const persisted = JSON.parse(await readFile(store, "utf8"));
      expect(persisted.tasks[0].items.map((item: { status: number }) => item.status)).toEqual([1, 1]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("两个进程并发收口同一工作时只创建一个验收且只完成一次源任务", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dida-multiprocess-finalize-"));
    const store = join(directory, "store.json");
    const worker = join(directory, "worker.ts");
    const metadata: WorkMetadata = {
      schemaVersion: 2, kind: "pi-todo-work", bindingKey: "tmux:demo:0.0", origin: "pi", lifecycle: "claimed",
      execution: { claimedAt: "2026-08-11T00:00:00.000Z" }, nextId: 2,
      tasks: [{ id: 1, subject: "步骤", itemId: "one", status: "completed" }],
    };
    await writeFile(store, JSON.stringify({ created: 1, completes: 0, tasks: [source(metadata, [{ id: "one", title: "步骤", status: 1 }])] }));
    await writeFile(worker, workerSource(repositoryModule));
    try {
      await Promise.all([run(worker, store, "finish"), run(worker, store, "finish")]);
      const persisted = JSON.parse(await readFile(store, "utf8"));
      expect(persisted.tasks.filter((task: DidaTask) => task.tags?.includes("pi-todo-acceptance"))).toHaveLength(1);
      expect(persisted.completes).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
