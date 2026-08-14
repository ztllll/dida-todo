import { describe, expect, it } from "bun:test";
import { DEFAULT_POLL_INTERVAL_MINUTES, resolvePollIntervalMinutes } from "../../extensions/dida-todo/config.js";

describe("自动领取轮询配置", () => {
  it("默认每 10 分钟检查一次", () => {
    expect(DEFAULT_POLL_INTERVAL_MINUTES).toBe(10);
    expect(resolvePollIntervalMinutes({ bindings: [] })).toBe(10);
  });

  it("允许显式覆盖检查间隔", () => {
    expect(resolvePollIntervalMinutes({ bindings: [], pollIntervalMinutes: 30 })).toBe(30);
  });
});
