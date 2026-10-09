import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Record<string, any>;

describe("dida-todo Pi Package manifest", () => {
  it("使用正式名称并只发布 dida-todo 扩展", () => {
    expect(pkg.name).toBe("dida-todo");
    expect(pkg.version).toBe("0.9.0");
    expect(pkg.private).toBe(true);
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi.extensions).toEqual(["./extensions/dida-todo"]);
    expect(pkg.files).toEqual([
      "extensions/dida-todo",
      "extensions/dsh",
      "dsh-plugin",
      "scripts/build-dsh.mjs",
      "README.md",
      "AGENTS.md",
      "CHANGELOG.md",
      "LICENSE",
    ]);
  });

  it("dsh 组合包与主包版本一致，声明 bundle 层且不覆盖任何内置插件行", async () => {
    const dsh = JSON.parse(readFileSync(new URL("../../dsh-plugin/package.json", import.meta.url), "utf8")) as Record<string, any>;
    const patch = readFileSync(new URL("../../dsh-plugin/cordis.patch.yml", import.meta.url), "utf8");
    expect(dsh.version).toBe(pkg.version);
    expect(dsh.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(dsh.dependencies["@suibiji/dida-cli"]).toBe(pkg.dependencies["@suibiji/dida-cli"]);
    expect(dsh.dependencies).not.toHaveProperty("@earendil-works/pi-coding-agent");
    // 只允许 insert 新行：顶层每一项都必须是 insert，不得按 id 覆盖/禁用 dsh 自带插件。
    const topLevel = patch.split("\n").filter((line) => line.startsWith("- "));
    expect(topLevel).toEqual(["- insert:"]);
  });

  it("声明运行依赖和 Pi peerDependencies", () => {
    expect(pkg.dependencies["@suibiji/dida-cli"]).toBeDefined();
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
      typebox: "*",
    });
  });
});
