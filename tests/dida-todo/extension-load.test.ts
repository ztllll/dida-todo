import { describe, expect, it } from "vitest";
import { createExtensionRuntime, loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

describe("dida-todo Extension 生命周期", () => {
  it("扩展工厂不得在 Runtime 绑定前调用 action API", async () => {
    const entry = new URL("../../extensions/dida-todo/index.ts", import.meta.url).pathname;
    const result = await loadExtensions([entry], new URL("../..", import.meta.url).pathname, undefined, createExtensionRuntime());
    expect(result.errors).toEqual([]);
    expect(result.extensions.map((extension) => extension.path)).toEqual([entry]);
  });
});
