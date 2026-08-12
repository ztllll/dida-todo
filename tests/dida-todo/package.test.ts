import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Record<string, any>;

describe("dida-todo Pi Package manifest", () => {
  it("使用正式名称并只发布 dida-todo 扩展", () => {
    expect(pkg.name).toBe("dida-todo");
    expect(pkg.version).toBe("0.6.5");
    expect(pkg.private).toBe(true);
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi.extensions).toEqual(["./extensions/dida-todo"]);
    expect(pkg.files).toEqual(["extensions/dida-todo", "README.md", "LICENSE"]);
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
