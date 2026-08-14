import type { DidaChecklistItem, DidaTask, LegacyWorkMetadata, Task, TaskStatus, WorkMetadata, WorkTask } from "./domain.js";
import { migrateWorkMetadata } from "./work-lifecycle.js";

const CURRENT_START = "<!-- dida-todo:start -->";
const CURRENT_END = "<!-- dida-todo:end -->";
const LEGACY_START = "<!-- pi-dida-todo:start -->";
const LEGACY_END = "<!-- pi-dida-todo:end -->";
const MANAGED_BLOCK = /<!-- (?:dida-todo|pi-dida-todo):start -->[\s\S]*?<!-- (?:dida-todo|pi-dida-todo):end -->/g;

function cloneTask(task: Task): Task {
  return {
    ...task,
    ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  };
}

export function encodeManagedContent(userContent: string, metadata: WorkMetadata): string {
  const cleanUserContent = stripManagedContent(userContent).trimEnd();
  const block = `${CURRENT_START}\n${JSON.stringify(metadata)}\n${CURRENT_END}`;
  return cleanUserContent ? `${cleanUserContent}\n\n${block}` : block;
}

export function stripManagedContent(content: string | undefined): string {
  return content ? content.replace(MANAGED_BLOCK, "").trimEnd() : "";
}

export function decodeMetadata(content: string | undefined): WorkMetadata | undefined {
  if (!content) return undefined;
  for (const [startMarker, endMarker] of [[CURRENT_START, CURRENT_END], [LEGACY_START, LEGACY_END]] as const) {
    const start = content.indexOf(startMarker);
    if (start === -1) continue;
    const end = content.indexOf(endMarker, start + startMarker.length);
    if (end === -1) continue;
    const raw = content.slice(start + startMarker.length, end).trim();
    try {
      const value = JSON.parse(raw) as {
        schemaVersion?: unknown;
        kind?: unknown;
        origin?: unknown;
        bindingKey?: unknown;
        nextId?: unknown;
        tasks?: unknown;
      };
      const validFields = typeof value.bindingKey === "string" && typeof value.nextId === "number" && Array.isArray(value.tasks);
      const isCurrent = value.schemaVersion === 3 && value.kind === "dida-todo-work" && (value.origin === "agent" || value.origin === "dida");
      const isLegacy = (value.schemaVersion === 1 || value.schemaVersion === 2)
        && value.kind === "pi-todo-work"
        && (value.schemaVersion === 1 || value.origin === "pi" || value.origin === "dida");
      if (!validFields || (!isCurrent && !isLegacy)) continue;
      const tasks = value.tasks as Task[];
      const metadata = {
        ...value,
        ...(isCurrent ? { schemaVersion: 3 as const, kind: "dida-todo-work" as const } : { kind: "pi-todo-work" as const }),
        tasks: tasks.map(cloneTask),
      } as WorkMetadata | LegacyWorkMetadata;
      return migrateWorkMetadata(metadata);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function metadataToItems(metadata: WorkMetadata, remoteItems: DidaChecklistItem[] = []): DidaChecklistItem[] {
  if (metadata.workType === "direct") return [];
  const byId = new Map(remoteItems.filter((item) => item.id).map((item) => [item.id as string, item]));
  return metadata.tasks
    .filter((task) => task.status !== "deleted")
    .map((task, index) => ({
      ...(task.itemId ? structuredClone(byId.get(task.itemId) ?? { id: task.itemId }) : {}),
      title: task.subject,
      status: task.status === "completed" ? 1 : 0,
      sortOrder: -(index + 1) * 1099511627776,
    }));
}

export function decodeWorkTask(remote: DidaTask, storedMetadata?: WorkMetadata): WorkTask | undefined {
  const contentMetadata = decodeMetadata(remote.content);
  const descriptionMetadata = decodeMetadata(remote.desc);
  const metadata = storedMetadata ?? contentMetadata ?? descriptionMetadata;
  if (!metadata) return undefined;
  const items = remote.items ?? [];
  const itemsById = new Map(items.filter((item) => item.id).map((item) => [item.id as string, item]));
  const availableWithoutId = [...items];

  const matchedItemIds = new Set<string>();
  const tasks = metadata.tasks.map((stored) => {
    let item = stored.itemId ? itemsById.get(stored.itemId) : undefined;
    if (!item) item = availableWithoutId.find((candidate) => candidate.title === stored.subject);
    if (!item || stored.status === "deleted") return cloneTask(stored);
    if (item.id) matchedItemIds.add(item.id);
    const completed = item.status === 1 || item.status === 2;
    const agentCompleted = stored.status === "completed" && stored.metadata?.source !== "dida";
    const status: TaskStatus = stored.status === "skipped"
      ? "skipped"
      : completed || agentCompleted
        ? "completed"
        : metadata.activeTaskId === stored.id
          ? "in_progress"
          : "pending";
    return {
      ...cloneTask(stored),
      ...(item.id ? { itemId: item.id } : {}),
      subject: item.title,
      status,
    };
  });

  let nextId = Math.max(metadata.nextId, ...tasks.map((task) => task.id + 1), 1);
  for (const item of items) {
    if (item.id && matchedItemIds.has(item.id)) continue;
    const duplicate = tasks.some((task) => task.status !== "deleted" && task.subject === item.title && (!item.id || task.itemId === item.id));
    if (duplicate) continue;
    const completed = item.status === 1 || item.status === 2;
    tasks.push({
      id: nextId++,
      subject: item.title,
      status: completed ? "completed" : "pending",
      ...(item.id ? { itemId: item.id } : {}),
      metadata: { source: "dida" },
    });
  }

  let normalizedMetadata = migrateWorkMetadata({ ...metadata, nextId, tasks });
  if (contentMetadata && !descriptionMetadata && remote.desc?.trim() && !normalizedMetadata.userDescription) {
    normalizedMetadata = { ...normalizedMetadata, userDescription: remote.desc };
  }
  const normalizedRemote = structuredClone(remote);
  const managedInDescription = Boolean(descriptionMetadata);
  if (managedInDescription) {
    if (normalizedMetadata.userDescription) normalizedRemote.desc = normalizedMetadata.userDescription;
    else delete normalizedRemote.desc;
  } else if (storedMetadata && normalizedMetadata.userDescription) {
    normalizedRemote.desc = normalizedMetadata.userDescription;
  }
  if (contentMetadata) normalizedRemote.content = stripManagedContent(remote.content);
  return {
    remote: normalizedRemote,
    metadata: normalizedMetadata,
    tasks,
    userContent: normalizedMetadata.userContent ?? (managedInDescription
      ? stripManagedContent(remote.desc)
      : stripManagedContent(remote.content)),
  };
}

export function synchronizeItemIds(metadata: WorkMetadata, remote: DidaTask): WorkMetadata {
  const items = remote.items ?? [];
  const unused = new Set(items.map((_, index) => index));
  const tasks = metadata.tasks.map((task) => {
    if (task.status === "deleted") return cloneTask(task);
    let index = task.itemId ? items.findIndex((item) => item.id === task.itemId) : -1;
    if (index < 0 || !unused.has(index)) {
      index = items.findIndex((item, candidateIndex) => unused.has(candidateIndex) && item.title === task.subject);
    }
    if (index < 0) return cloneTask(task);
    unused.delete(index);
    const item = items[index];
    return { ...cloneTask(task), ...(item.id ? { itemId: item.id } : {}) };
  });
  return { ...metadata, tasks };
}
