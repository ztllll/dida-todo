import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { DidaCliGateway } from "../../extensions/dida-todo/gateway.js";

describe("Dida CLI Adapter seam", () => {
  it("通过 argv 和 JSON 驱动 Checklist 工作任务", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dida-gateway-"));
    const store = join(dir, "store.json");
    await writeFile(store, JSON.stringify({ project: { id: "p1", name: "测试", kind: "TASK" }, tasks: [], nextTask: 1, nextItem: 1 }));
    const fake = resolve("tests/dida-todo/fake-dida.mjs");
    const pi = {
      exec: async (command: string, args: string[]) => {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, FAKE_DIDA_STORE: store } });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
      },
    } as never;
    const gateway = new DidaCliGateway(pi, fake);

    expect((await gateway.listProjects()).map((project) => project.id)).toEqual(["p1"]);
    const newProject = await gateway.createProject("自动创建项目");
    expect(newProject).toMatchObject({ name: "自动创建项目", kind: "TASK", viewMode: "list" });

    const created = await gateway.createTask({
      title: "实现联网 Todo",
      projectId: "p1",
      content: "managed",
      items: [{ title: "研究接口", status: 0 }],
      tags: ["pi-todo"],
    });
    const fetched = await gateway.getTask("p1", created.id);

    expect(fetched.items?.[0]).toMatchObject({ id: "item-1", title: "研究接口", status: 0 });
    expect(JSON.parse(await readFile(store, "utf8")).tasks).toHaveLength(1);
  });
});
