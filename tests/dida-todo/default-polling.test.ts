import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_INTERVAL_MINUTES, resolvePollIntervalMinutes } from "../../extensions/dida-todo/config.js";

describe("默认主动轮询", () => {
  it("未配置时默认每 10 分钟轮询", () => {
    expect(DEFAULT_POLL_INTERVAL_MINUTES).toBe(10);
    expect(resolvePollIntervalMinutes({ bindings: [] })).toBe(10);
  });

  it("允许显式覆盖轮询间隔", () => {
    expect(resolvePollIntervalMinutes({ bindings: [], pollIntervalMinutes: 30 })).toBe(30);
  });
});
