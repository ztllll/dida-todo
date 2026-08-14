import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { JsonWorkStateStore, MemoryWorkStateStore } from "../../extensions/dida-todo/state-store.js";
import type { WorkMetadata } from "../../extensions/dida-todo/domain.js";

const metadata: WorkMetadata = { schemaVersion: 3, kind: "dida-todo-work", bindingKey: "tmux:demo:0.0", origin: "dida", lifecycle: "claimed",
workType: "checklist",
userContent: "干净正文",
userDescription: "干净描述",
nextId: 2,
tasks: [{ id: 1, subject: "交付结果", status: "pending", itemId: "item-1" }], };

describe("本机受管状态库", () => {
  it("原子持久化工作 metadata，滴答可见字段无需承载机器 JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-state-"));
    const path = join(dir, "state.json");
    const store = new JsonWorkStateStore(path);

    await store.set("project", "work", metadata);
    const restored = await new JsonWorkStateStore(path).get("project", "work");
    const persisted = JSON.parse(await readFile(path, "utf8"));

    expect(restored).toEqual(metadata);
    expect(persisted.schemaVersion).toBe(1);
    expect(JSON.stringify(persisted)).toContain("tmux:demo:0.0");
  });

  it("以 source work 和 occurrence 维护验收关联及返工幂等状态", async () => {
    const store = new MemoryWorkStateStore();
    await store.setAcceptance("project", "acceptance", {
      sourceWorkId: "work",
      sourceOccurrence: "occurrence",
    });

    expect(await store.findAcceptance("project", "work", "occurrence")).toBe("acceptance");
    await store.setRework("project", "acceptance", "rework");
    expect(await store.getAcceptance("project", "acceptance")).toEqual({
      sourceWorkId: "work",
      sourceOccurrence: "occurrence",
      reworkWorkId: "rework",
    });
  });
});
