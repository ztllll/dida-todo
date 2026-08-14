import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

type PackageManifest = {
  name: string;
  version: string;
  private: boolean;
  keywords: string[];
  files: string[];
  omp: { extensions: string[] };
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
};

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;

describe("dida-todo OMP plugin manifest", () => {
  it("uses the OMP v0.7 release contract", () => {
    expect(pkg.name).toBe("dida-todo");
    expect(pkg.version).toBe("0.7.0");
    expect(pkg.private).toBe(true);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["omp-plugin", "omp-extension"]));
    expect(pkg.omp.extensions).toEqual(["./extensions/dida-todo"]);
    expect(pkg.files).toEqual([
      "extensions/dida-todo",
      "docs/adr",
      "docs/development",
      "docs/operations",
      "docs/research",
      "README.md",
      "CHANGELOG.md",
      "CONTEXT.md",
      "DEVELOPMENT.md",
      "LICENSE",
    ]);
  });

  it("declares the bundled CLI plus OMP peer and local Bun test dependencies", () => {
    expect(pkg.dependencies["@suibiji/dida-cli"]).toBeDefined();
    expect(pkg.peerDependencies).toEqual({
      "@oh-my-pi/pi-coding-agent": ">=17.3.3 <18",
      "@oh-my-pi/pi-tui": ">=17.3.3 <18",
    });
    expect(pkg.devDependencies.bun).toBe("1.3.14");
    expect(pkg.devDependencies["@types/bun"]).toBe("1.3.14");
    expect(pkg.engines).toEqual({ node: ">=20", bun: ">=1.3.14" });
  });
});
