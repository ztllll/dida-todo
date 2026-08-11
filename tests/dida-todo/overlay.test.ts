import { describe, expect, it } from "vitest";
import type { Task } from "../../extensions/dida-todo/domain.js";
import { TodoOverlay } from "../../extensions/dida-todo/overlay.js";

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

describe("Todo Overlay 完成项生命周期", () => {
  it("初始同步时不展示历史完成项", () => {
    let tasks = [task(1, "completed")];
    const ui = new FakeUI();
    const overlay = new TodoOverlay(() => tasks, () => "work", () => "工作", () => 12, "ctrl+shift+t");
    overlay.setUI(ui as never);

    overlay.update(true);

    expect(overlay.isRegistered()).toBe(false);
    expect(ui.widgets.size).toBe(0);
  });

  it("本轮刚完成的项短暂显示，agent settled 后自动卸载 Overlay", () => {
    let tasks = [task(1, "pending")];
    const ui = new FakeUI();
    const overlay = new TodoOverlay(() => tasks, () => "work", () => "工作", () => 12, "ctrl+shift+t");
    overlay.setUI(ui as never);
    overlay.update(true);
    expect(overlay.isRegistered()).toBe(true);

    tasks = [task(1, "completed")];
    overlay.update();
    expect(overlay.isRegistered()).toBe(true);

    overlay.hideCompletedFromPreviousTurn();
    expect(overlay.isRegistered()).toBe(false);
    expect(ui.widgets.size).toBe(0);
  });

  it("切换工作时自动隐藏新工作的历史完成项，只保留未完成项", () => {
    let workId = "work-a";
    let tasks = [task(1, "pending")];
    const ui = new FakeUI();
    const overlay = new TodoOverlay(() => tasks, () => workId, () => "工作", () => 12, "ctrl+shift+t");
    overlay.setUI(ui as never);
    overlay.update(true);

    workId = "work-b";
    tasks = [task(1, "completed")];
    overlay.update();

    expect(overlay.isRegistered()).toBe(false);
    expect(ui.widgets.size).toBe(0);
  });
});
