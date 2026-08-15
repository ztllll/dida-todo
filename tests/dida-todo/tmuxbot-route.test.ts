import { describe, expect, it } from "vitest";
import { detectProvisioningNamespace } from "../../extensions/dida-todo/tmuxbot-route.js";

describe("tmuxbot IM route provisioning identity", () => {
  it("通过 canonical inventory 精确识别 channel 与 route name", async () => {
    const pi = {
      async exec(command: string, args: string[]) {
        expect(command).toBe("tmuxbot");
        expect(args).toEqual(["admin", "--file", "/tmp/bindings.yaml", "inventory", "--json"]);
        return {
          code: 0,
          stdout: JSON.stringify({ routes: [{ name: "tmuxbot-admin", channel: "telegram", tmux_target: "tmuxbot-admin:0.0" }] }),
          stderr: "",
        };
      },
    } as never;

    const result = await detectProvisioningNamespace(pi, "tmuxbot-admin:0.0", { TMUXBOT_BINDINGS: "/tmp/bindings.yaml" });

    expect(result.hostName).toBeTruthy();
    expect(result.imRoute).toEqual({ routeName: "tmuxbot-admin", channel: "telegram" });
  });

  it("inventory 不可用或歧义时 fail closed 为 hostname-only", async () => {
    const failed = await detectProvisioningNamespace({ async exec() { return { code: 1, stdout: "", stderr: "failed" }; } } as never, "demo:0.0", { TMUXBOT_BINDINGS: "/tmp/bindings.yaml" });
    expect(failed.hostName).toBeTruthy();
    expect(failed.imRoute).toBeUndefined();

    const ambiguous = await detectProvisioningNamespace({
      async exec() {
        return { code: 0, stdout: JSON.stringify({ routes: [
          { name: "one", channel: "telegram", tmux_target: "demo:0.0" },
          { name: "two", channel: "feishu", tmux_target: "demo:0.0" },
        ] }), stderr: "" };
      },
    } as never, "demo:0.0", { TMUXBOT_BINDINGS: "/tmp/bindings.yaml" });
    expect(ambiguous.imRoute).toBeUndefined();
  });
});
