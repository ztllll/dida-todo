import { describe, expect, it } from "bun:test";
import { BUNDLED_DIDA_COMMAND, resolveBinding, resolveDidaCommand } from "../../extensions/dida-todo/config.js";
import type { DidaTodoConfig } from "../../extensions/dida-todo/domain.js";

const config: DidaTodoConfig = {
  bindings: [
    { key: "topic:example", projectId: "project-tmux", label: "Example" },
    { key: "tmux:example:0.0", projectId: "project-tmux", cwd: "/workspace/example-project" },
    { key: "cwd:/workspace/example-project", projectId: "project-cwd" },
  ],
};

describe("项目绑定解析 seam", () => {
  it("精确 tmux 命中后返回同 projectId 的规范化话题绑定", () => {
    expect(resolveBinding(config, "/workspace/example-project", "example:0.0", "Example")).toEqual({
      key: "topic:example",
      projectId: "project-tmux",
      label: "Example",
    });
    expect(resolveBinding(config, "/wrong", "example:0.0", "Example")).toBeUndefined();
  });

  it("tmux 入口改变时通过话题别名回到同一 projectId", () => {
    expect(resolveBinding(config, "/workspace/other", "renamed:1.0", " example ")?.projectId).toBe("project-tmux");
  });

  it("没有 tmux 或话题绑定时回退到规范化 cwd", () => {
    expect(resolveBinding(config, "/workspace/example-project/", undefined)?.projectId).toBe("project-cwd");
  });

  it("默认启用自动 provisioning，也允许显式关闭", () => {
    const defaults: DidaTodoConfig = { bindings: [] };
    const disabled: DidaTodoConfig = { bindings: [], autoProvisionProject: false };
    expect(defaults.autoProvisionProject).toBeUndefined();
    expect(disabled.autoProvisionProject).toBe(false);
  });

  it("默认使用包内安装的 dida CLI，仍允许显式覆盖", () => {
    expect(resolveDidaCommand({ bindings: [] })).toBe(BUNDLED_DIDA_COMMAND);
    expect(resolveDidaCommand({ bindings: [], didaCommand: "/custom/dida" })).toBe("/custom/dida");
  });
});
