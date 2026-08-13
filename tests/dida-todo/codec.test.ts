import { describe, expect, it } from "vitest";
import { decodeWorkTask, encodeManagedContent, metadataToItems } from "../../extensions/dida-todo/codec.js";
import type { DidaTask, WorkMetadata } from "../../extensions/dida-todo/domain.js";

const metadata: WorkMetadata = {
  schemaVersion: 2,
  kind: "pi-todo-work",
  bindingKey: "tmux:example:0.0",
  origin: "pi",
  lifecycle: "claimed",
  execution: { claimedAt: "2026-08-10T08:00:00.000Z" },
  nextId: 3,
  activeTaskId: 2,
  tasks: [
    { id: 1, subject: "研究接口", status: "completed", itemId: "item-a" },
    { id: 2, subject: "实现适配器", status: "in_progress", activeForm: "正在实现适配器", itemId: "item-b" },
  ],
};

describe("工作任务编解码 seam", () => {
  it("保留用户内容并往返 Pi Todo 元数据", () => {
    const content = encodeManagedContent("人工备注", metadata);
    const remote: DidaTask = {
      id: "work-1",
      projectId: "project-1",
      title: "实现联网 Todo",
      content,
      status: 0,
      priority: 0,
      items: metadataToItems(metadata),
    };

    const decoded = decodeWorkTask(remote);

    expect(decoded?.userContent).toBe("人工备注");
    expect(decoded?.metadata).toEqual(metadata);
    expect(decoded?.tasks).toEqual(metadata.tasks);
  });

  it("导入用户在滴答中手工新增的 Checklist Item", () => {
    const remote: DidaTask = {
      id: "work-1",
      projectId: "project-1",
      title: "实现联网 Todo",
      content: encodeManagedContent("", metadata),
      status: 0,
      priority: 0,
      items: [
        { id: "item-a", title: "研究接口", status: 1, sortOrder: -1 },
        { id: "item-b", title: "实现适配器", status: 0, sortOrder: -2 },
        { id: "item-user", title: "用户从滴答新增的任务", status: 0, sortOrder: -3 },
      ],
    };

    const decoded = decodeWorkTask(remote);

    expect(decoded?.tasks.at(-1)).toEqual({
      id: 3,
      subject: "用户从滴答新增的任务",
      status: "pending",
      itemId: "item-user",
      metadata: { source: "dida" },
    });
    expect(decoded?.metadata.nextId).toBe(4);
  });

  it("Pi 已完成步骤不会被远端陈旧 pending Item 降级", () => {
    const remote: DidaTask = {
      id: "work-1",
      projectId: "project-1",
      title: "实现联网 Todo",
      content: encodeManagedContent("", metadata),
      status: 0,
      priority: 0,
      items: [
        { id: "item-a", title: "研究接口", status: 0 },
        { id: "item-b", title: "实现适配器", status: 0 },
      ],
    };

    const decoded = decodeWorkTask(remote);

    expect(decoded?.tasks[0]?.status).toBe("completed");
    expect(decoded?.tasks[1]?.status).toBe("in_progress");
  });

  it("以滴答 Item 的标题和完成状态刷新展示状态", () => {
    const remote: DidaTask = {
      id: "work-1",
      projectId: "project-1",
      title: "实现联网 Todo",
      content: encodeManagedContent("", metadata),
      status: 0,
      priority: 0,
      items: [
        { id: "item-a", title: "研究正式接口", status: 1, sortOrder: -1 },
        { id: "item-b", title: "实现适配器", status: 1, sortOrder: -2 },
      ],
    };

    const decoded = decodeWorkTask(remote);

    expect(decoded?.tasks).toEqual([
      { id: 1, subject: "研究正式接口", status: "completed", itemId: "item-a" },
      { id: 2, subject: "实现适配器", status: "completed", activeForm: "正在实现适配器", itemId: "item-b" },
    ]);
  });
});
