import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Record<string, any>;

describe("dida-todo Pi Package manifest", () => {
  it("使用正式名称并只发布 dida-todo 扩展", () => {
    expect(pkg.name).toBe("dida-todo");
    expect(pkg.version).toBe("0.9.1");
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

  it("仓库根同时是 dsh 组合包：DSH Hub 与 dsh plugin add 只认根 package.json，配置层只新增不覆盖", () => {
    const patch = readFileSync(new URL("../../dsh-plugin/cordis.patch.yml", import.meta.url), "utf8");
    expect(pkg.dsh.bundle.patch).toBe("./dsh-plugin/cordis.patch.yml");
    expect(pkg.exports["."]).toBe("./dsh-plugin/index.mjs");
    expect(pkg.exports["./locale/*.json"]).toBe("./dsh-plugin/locale/*.json");
    expect(pkg.files).toContain("dsh-plugin");
    expect(existsSync(new URL("../../dsh-plugin/package.json", import.meta.url))).toBe(false);
    expect(patch).toContain("name: dida-todo\n");
    // 只允许 insert 新行：不得按 id 覆盖/禁用 dsh 自带插件（卸载才能恢复原样）。
    expect(patch.split("\n").filter((line) => line.startsWith("- "))).toEqual(["- insert:"]);
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
