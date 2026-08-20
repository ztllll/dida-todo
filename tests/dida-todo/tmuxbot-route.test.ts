import { describe, expect, it } from "vitest";
import { canAutoProvisionNamespace, detectProvisioningNamespace, resolveTmuxbotBindingsPath } from "../../extensions/dida-todo/tmuxbot-route.js";

describe("tmuxbot IM route provisioning identity", () => {
  it("通过 bindings 文件精确识别 channel 与 route name", async () => {
    const result = await detectProvisioningNamespace({} as never, "tmuxbot-admin:0.0", { TMUXBOT_BINDINGS: "/tmp/bindings.yaml" }, "/home/test", async (path) => {
      expect(path).toBe("/tmp/bindings.yaml");
      return "bindings:\n  - name: tmuxbot-admin\n    channel: telegram\n    tmux_session: tmuxbot-admin\n    tmux_window: 0\n    tmux_pane: 0\n";
    });

    expect(result.hostName).toBeTruthy();
    expect(result.imRoute).toEqual({ routeName: "tmuxbot-admin", channel: "telegram" });
    expect(canAutoProvisionNamespace(result)).toBe(true);
  });

  it("无环境变量时使用标准 tmuxbot bindings 路径", () => {
    expect(resolveTmuxbotBindingsPath({}, "/home/hbhy")).toBe("/home/hbhy/tmuxbot/bindings.yaml");
  });

  it("inventory 不可用或歧义时 fail closed 为 hostname-only", async () => {
    const failed = await detectProvisioningNamespace({} as never, "demo:0.0", { TMUXBOT_BINDINGS: "/tmp/bindings.yaml" }, "/home/test", async () => { throw new Error("failed"); });
    expect(failed.hostName).toBeTruthy();
    expect(failed.imRoute).toBeUndefined();

    const ambiguous = await detectProvisioningNamespace({} as never, "demo:0.0", { TMUXBOT_BINDINGS: "/tmp/bindings.yaml" }, "/home/test", async () => "bindings:\n  - name: one\n    channel: telegram\n    tmux_target: demo:0.0\n  - name: two\n    channel: feishu\n    tmux_target: demo:0.0\n");
    expect(ambiguous.imRoute).toBeUndefined();
    expect(canAutoProvisionNamespace(failed)).toBe(false);
    expect(canAutoProvisionNamespace(ambiguous)).toBe(false);
  });
});
