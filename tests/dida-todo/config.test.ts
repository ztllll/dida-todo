import { describe, expect, it } from "vitest";
import { BUNDLED_DIDA_COMMAND, resolveBinding, resolveDidaCommand } from "../../extensions/dida-todo/config.js";
import type { DidaTodoConfig } from "../../extensions/dida-todo/domain.js";

const config: DidaTodoConfig = {
  bindings: [
    { key: "tmux:example:0.0", projectId: "project-tmux", cwd: "/workspace/example-project" },
    { key: "cwd:/workspace/example-project", projectId: "project-cwd" },
  ],
};

describe("项目绑定解析 seam", () => {
  it("优先使用 tmux target 并校验 cwd", () => {
    expect(resolveBinding(config, "/workspace/example-project", "example:0.0")?.projectId).toBe("project-tmux");
    expect(resolveBinding(config, "/wrong", "example:0.0")).toBeUndefined();
  });

  it("没有 tmux 绑定时回退到规范化 cwd", () => {
    expect(resolveBinding(config, "/workspace/example-project/", undefined)?.projectId).toBe("project-cwd");
  });

  it("tmux 绑定指向已删除清单时回退到仍存在的 cwd 绑定", () => {
    expect(resolveBinding(config, "/workspace/example-project", "example:0.0", new Set(["project-cwd"]))?.projectId).toBe("project-cwd");
    expect(resolveBinding(config, "/workspace/example-project", "example:0.0", new Set())).toBeUndefined();
  });

  it("默认使用包内安装的 dida CLI，仍允许显式覆盖", () => {
    expect(resolveDidaCommand({ bindings: [] })).toBe(BUNDLED_DIDA_COMMAND);
    expect(resolveDidaCommand({ bindings: [], didaCommand: "/custom/dida" })).toBe("/custom/dida");
  });
});
