import { describe, expect, it } from "bun:test";
import type { Task } from "../../extensions/dida-todo/domain.js";
import { DidaTodoOverlay } from "../../extensions/dida-todo/overlay.js";

class FakeUI {
  widgets = new Map<string, unknown>();
  calls: Array<{ key: string; value: unknown }> = [];
  setWidget(key: string, value: unknown) {
    this.calls.push({ key, value });
    if (value === undefined) this.widgets.delete(key);
    else this.widgets.set(key, value);
  }
}

function task(id: number, status: Task["status"]): Task {
  return { id, subject: `任务 ${id}`, status };
}

describe("Todo Overlay 对话生命周期", () => {

  it("初始同步时展示当前工作的历史完成项", () => {
    let tasks = [task(1, "completed")];
    const ui = new FakeUI();
    const overlay = new DidaTodoOverlay(() => tasks, () => 12, "ctrl+shift+t");
    overlay.setUI(ui as never);

    overlay.update(true);

    expect(overlay.isRegistered()).toBe(true);
    expect(ui.widgets.size).toBe(1);
  });

  it("最后一步完成后跨 agent settled 持续展示，直到新工作取代它", () => {
    let workId = "work-a";
    let tasks = [task(1, "pending")];
    const ui = new FakeUI();
    const overlay = new DidaTodoOverlay(() => tasks, () => 12, "ctrl+shift+t");
    overlay.setUI(ui as never);
    overlay.update(true);
    expect(overlay.isRegistered()).toBe(true);

    tasks = [task(1, "completed")];
    overlay.update();
    expect(overlay.isRegistered()).toBe(true);
    expect(ui.widgets.size).toBe(1);

    workId = "work-b";
    tasks = [];
    overlay.update();
    expect(overlay.isRegistered()).toBe(false);
    expect(ui.widgets.size).toBe(0);
  });

  it("切换工作时展示新工作当前 Checklist", () => {
    let workId = "work-a";
    let tasks = [task(1, "pending")];
    const ui = new FakeUI();
    const overlay = new DidaTodoOverlay(() => tasks, () => 12, "ctrl+shift+t");
    overlay.setUI(ui as never);
    overlay.update(true);

    workId = "work-b";
    tasks = [task(1, "completed")];
    overlay.update();

    expect(overlay.isRegistered()).toBe(true);
    expect(ui.widgets.size).toBe(1);
  });
});
