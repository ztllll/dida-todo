import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_INTERVAL_MINUTES, resolvePollIntervalMinutes } from "../../extensions/dida-todo/config.js";

describe("旧轮询配置兼容", () => {
  it("保留默认数值解析以兼容旧配置，但运行时 Poller 为 no-op", () => {
    expect(DEFAULT_POLL_INTERVAL_MINUTES).toBe(10);
    expect(resolvePollIntervalMinutes({ bindings: [] })).toBe(10);
  });

  it("继续接受旧的显式间隔，避免升级时配置失效", () => {
    expect(resolvePollIntervalMinutes({ bindings: [], pollIntervalMinutes: 30 })).toBe(30);
  });
});
