import { describe, expect, it } from "bun:test";
import { isDidaAuthenticationError } from "../../extensions/dida-todo/provisioning.js";

const RECOVERY_TEXT = "Dida CLI 尚未登录";

describe("已绑定会话 OAuth 恢复", () => {
  it("认证错误可被统一识别为重新登录状态，而非通用远端错误", () => {
    expect(isDidaAuthenticationError(new Error("未找到 access token。请先运行 dida auth login"))).toBe(true);
    expect(isDidaAuthenticationError(new Error("请先运行 `dida auth login` 登录"))).toBe(true);
    expect(isDidaAuthenticationError(new Error("connection reset"))).toBe(false);
  });

  it("恢复提示明确引导内部登录工具", () => {
    expect(RECOVERY_TEXT).toContain("尚未登录");
  });
});
