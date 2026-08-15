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

  it("Checklist 可从 desc 恢复 managed metadata，并还原用户原始描述", () => {
    const checklistMetadata: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "tmux:pi-agent:0.0",
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      userDescription: "用户原始描述",
      nextId: 2,
      tasks: [{ id: 1, subject: "等待确认", status: "pending", itemId: "item-1" }],
    };
    const decoded = decodeWorkTask({
      id: "work-desc",
      projectId: "project-1",
      title: "Checklist",
      content: "",
      desc: encodeManagedContent("用户原始正文", checklistMetadata),
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [{ id: "item-1", title: "等待确认", status: 0 }],
    });

    expect(decoded?.userContent).toBe("用户原始正文");
    expect(decoded?.remote.desc).toBe("用户原始描述");
    expect(decoded?.metadata).toMatchObject({ userDescription: "用户原始描述" });
  });

  it("旧 Checklist 从 content 读取时自动记住原始用户描述", () => {
    const checklistMetadata: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "tmux:pi-agent:0.0",
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      nextId: 1,
      tasks: [],
    };
    const decoded = decodeWorkTask({
      id: "legacy-content",
      projectId: "project-1",
      title: "旧 Checklist",
      content: encodeManagedContent("正文", checklistMetadata),
      desc: "用户原始描述",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [],
    });

    expect(decoded?.metadata).toMatchObject({ userDescription: "用户原始描述" });
    expect(decoded?.remote.desc).toBe("用户原始描述");
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

  it("用户修改顶层内容后以滴答最新语义重新打开本机 skipped 步骤", () => {
    const stored: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "tmux:example:0.0",
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      userDescription: "只勾选一个，保持未完成状态",
      didaSemanticSnapshot: JSON.stringify({ title: "定时轮询测试", description: "只勾选一个，保持未完成状态", content: "" }),
      keepOpen: true,
      nextId: 3,
      tasks: [
        { id: 1, subject: "已完成", status: "completed", itemId: "item-1", metadata: { source: "dida" } },
        { id: 2, subject: "原本保留未勾", status: "skipped", itemId: "item-2", metadata: { source: "dida", resolution: "按原要求保留未勾" } },
      ],
    };
    const remote: DidaTask = {
      id: "edited-work",
      projectId: "project-1",
      title: "定时轮询测试",
      desc: "现在执行第二项，并继续保持顶层未完成",
      content: "",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [
        { id: "item-1", title: "已完成", status: 1 },
        { id: "item-2", title: "原本保留未勾", status: 0 },
      ],
    };

    const decoded = decodeWorkTask(remote, stored);

    expect(decoded?.remote.desc).toBe("现在执行第二项，并继续保持顶层未完成");
    expect(decoded?.tasks[1]?.status).toBe("pending");
    expect(decoded?.metadata).not.toHaveProperty("keepOpen");
  });

  it("同步回写导致的描述形态变化不会误重开 skipped 步骤", () => {
    const stored: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "tmux:example:0.0",
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      userTitle: "测试任务",
      userDescription: "只勾选一个，保持未完成状态",
      userContent: "补充正文",
      didaSemanticSnapshot: JSON.stringify({ title: "测试任务", description: "只勾选一个，保持未完成状态\n\n补充正文", content: "" }),
      keepOpen: true,
      nextId: 2,
      tasks: [{ id: 1, subject: "保留未勾", status: "skipped", itemId: "item-1", metadata: { source: "dida" } }],
    };

    const decoded = decodeWorkTask({
      id: "same-semantics",
      projectId: "project-1",
      title: "测试任务",
      desc: "只勾选一个，保持未完成状态\n\n补充正文",
      content: "",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [{ id: "item-1", title: "保留未勾", status: 0 }],
    }, stored);

    expect(decoded?.tasks[0]?.status).toBe("skipped");
    expect(decoded?.metadata).toMatchObject({ keepOpen: true });
  });

  it("服务端重写同名 Item ID 时一对一恢复，并移除远端已不存在的旧 Dida Item", () => {
    const stored: WorkMetadata = {
      schemaVersion: 2,
      kind: "pi-todo-work",
      bindingKey: "tmux:example:0.0",
      origin: "dida",
      lifecycle: "claimed",
      workType: "checklist",
      nextId: 7,
      tasks: [
        { id: 1, subject: "二级任务", status: "completed", itemId: "old-1", metadata: { source: "dida", resolution: "仅完成第一项" } },
        { id: 2, subject: "二级任务", status: "pending", itemId: "old-2", metadata: { source: "dida" } },
        { id: 3, subject: "测试", status: "pending", itemId: "old-3", metadata: { source: "dida" } },
        { id: 4, subject: "二级任务", status: "pending", itemId: "old-4", metadata: { source: "dida" } },
        { id: 5, subject: "二级任务", status: "pending", itemId: "stale-5", metadata: { source: "dida" } },
        { id: 6, subject: "二级任务", status: "pending", itemId: "stale-6", metadata: { source: "dida" } },
      ],
    };
    const remote: DidaTask = {
      id: "duplicate-items",
      projectId: "project-1",
      title: "同名 Checklist",
      status: 0,
      priority: 5,
      kind: "CHECKLIST",
      items: [
        { id: "new-1", title: "二级任务", status: 1 },
        { id: "new-2", title: "二级任务", status: 0 },
        { id: "new-3", title: "测试", status: 0 },
        { id: "new-4", title: "二级任务", status: 0 },
      ],
    };

    const decoded = decodeWorkTask(remote, stored);

    expect(decoded?.tasks).toEqual([
      { id: 1, subject: "二级任务", status: "completed", itemId: "new-1", metadata: { source: "dida", resolution: "仅完成第一项" } },
      { id: 2, subject: "二级任务", status: "pending", itemId: "new-2", metadata: { source: "dida" } },
      { id: 3, subject: "测试", status: "pending", itemId: "new-3", metadata: { source: "dida" } },
      { id: 4, subject: "二级任务", status: "pending", itemId: "new-4", metadata: { source: "dida" } },
    ]);
  });
});
