import type { DidaChecklistItem, DidaTask, Task, TaskStatus, WorkMetadata, WorkTask } from "./domain.js";
import { migrateWorkMetadata } from "./work-lifecycle.js";

const START = "<!-- pi-dida-todo:start -->";
const END = "<!-- pi-dida-todo:end -->";

function cloneTask(task: Task): Task {
  return {
    ...task,
    ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  };
}

export function encodeManagedContent(userContent: string, metadata: WorkMetadata): string {
  const cleanUserContent = stripManagedContent(userContent).trimEnd();
  const block = `${START}\n${JSON.stringify(metadata)}\n${END}`;
  return cleanUserContent ? `${cleanUserContent}\n\n${block}` : block;
}

export function stripManagedContent(content: string | undefined): string {
  if (!content) return "";
  const start = content.indexOf(START);
  if (start === -1) return content;
  const end = content.indexOf(END, start + START.length);
  if (end === -1) return content;
  return `${content.slice(0, start)}${content.slice(end + END.length)}`.trimEnd();
}

export function decodeMetadata(content: string | undefined): WorkMetadata | undefined {
  if (!content) return undefined;
  const start = content.indexOf(START);
  const end = content.indexOf(END, start + START.length);
  if (start === -1 || end === -1) return undefined;
  const raw = content.slice(start + START.length, end).trim();
  try {
    const value = JSON.parse(raw) as Partial<WorkMetadata>;
    if (
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      value.kind !== "pi-todo-work" ||
      typeof value.bindingKey !== "string" ||
      typeof value.nextId !== "number" ||
      !Array.isArray(value.tasks)
    ) {
      return undefined;
    }
    const metadata = {
      ...value,
      kind: "pi-todo-work",
      tasks: value.tasks.map(cloneTask),
    } as WorkMetadata;
    return migrateWorkMetadata(metadata);
  } catch {
    return undefined;
  }
}

export function metadataToItems(metadata: WorkMetadata, remoteItems: DidaChecklistItem[] = []): DidaChecklistItem[] {
  if (metadata.schemaVersion === 2 && metadata.workType === "direct") return [];
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
  const unusedItemIndexes = new Set(items.map((_, index) => index));
  const tasks = metadata.tasks.flatMap((stored) => {
    if (stored.status === "deleted") return [cloneTask(stored)];
    let itemIndex = stored.itemId
      ? items.findIndex((item, index) => unusedItemIndexes.has(index) && item.id === stored.itemId)
      : -1;
    if (itemIndex < 0) {
      itemIndex = items.findIndex((item, index) => unusedItemIndexes.has(index) && item.title === stored.subject);
    }
    if (itemIndex < 0) {
      return stored.metadata?.source === "dida" ? [] : [cloneTask(stored)];
    }
    unusedItemIndexes.delete(itemIndex);
    const item = items[itemIndex];
    const completed = item.status === 1 || item.status === 2;
    const piCompleted = stored.status === "completed" && stored.metadata?.source !== "dida";
    const status: TaskStatus = stored.status === "skipped"
      ? "skipped"
      : completed || piCompleted
        ? "completed"
        : metadata.activeTaskId === stored.id
          ? "in_progress"
          : "pending";
    return [{
      ...cloneTask(stored),
      ...(item.id ? { itemId: item.id } : {}),
      subject: item.title,
      status,
    }];
  });

  let nextId = Math.max(metadata.nextId, ...tasks.map((task) => task.id + 1), 1);
  for (const itemIndex of unusedItemIndexes) {
    const item = items[itemIndex];
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
  const legacyManagedInDescription = Boolean(descriptionMetadata);
  const checklist = normalizedMetadata.workType === "checklist" || remote.kind === "CHECKLIST" || items.length > 0;
  const remoteDescription = legacyManagedInDescription
    ? normalizedMetadata.userDescription ?? ""
    : remote.desc?.trim() ?? "";
  const remoteContent = legacyManagedInDescription
    ? stripManagedContent(remote.desc)
    : stripManagedContent(remote.content);
  const semanticSnapshot = JSON.stringify({
    title: remote.title,
    description: remoteDescription,
    content: checklist ? "" : remoteContent,
  });
  const storedDescription = checklist
    ? [normalizedMetadata.userDescription, normalizedMetadata.userContent].filter(Boolean).join("\n\n")
    : normalizedMetadata.userDescription ?? "";
  const didaContentChanged = normalizedMetadata.origin === "dida" && storedMetadata !== undefined && (
    normalizedMetadata.didaSemanticSnapshot !== undefined
      ? normalizedMetadata.didaSemanticSnapshot !== semanticSnapshot
      : (normalizedMetadata.userTitle !== undefined && normalizedMetadata.userTitle !== remote.title)
        || storedDescription !== remoteDescription
        || (!checklist && (normalizedMetadata.userContent ?? "") !== remoteContent)
  );
  if (didaContentChanged) {
    const reopenedTasks = tasks.map((task) => {
      if (task.status !== "skipped") return cloneTask(task);
      const metadata = task.metadata ? { ...task.metadata } : undefined;
      if (metadata) delete metadata.resolution;
      return { ...cloneTask(task), status: "pending" as const, ...(metadata && Object.keys(metadata).length ? { metadata } : { metadata: undefined }) };
    });
    const { keepOpen: _keepOpen, ...current } = normalizedMetadata;
    normalizedMetadata = migrateWorkMetadata({
      ...current,
      userTitle: remote.title,
      didaSemanticSnapshot: semanticSnapshot,
      ...(checklist
        ? { userDescription: remoteDescription }
        : { userDescription: remoteDescription, userContent: remoteContent }),
      lifecycle: "claimed",
      tasks: reopenedTasks,
    });
    tasks.splice(0, tasks.length, ...reopenedTasks);
  } else {
    if (normalizedMetadata.origin === "dida" && normalizedMetadata.didaSemanticSnapshot === undefined) {
      normalizedMetadata = { ...normalizedMetadata, userTitle: remote.title, didaSemanticSnapshot: semanticSnapshot };
    }
    if (contentMetadata && !descriptionMetadata && remote.desc?.trim() && !normalizedMetadata.userDescription) {
      normalizedMetadata = { ...normalizedMetadata, userDescription: remote.desc };
    }
  }
  const normalizedRemote = structuredClone(remote);
  if (legacyManagedInDescription) {
    if (normalizedMetadata.userDescription) normalizedRemote.desc = normalizedMetadata.userDescription;
    else delete normalizedRemote.desc;
  }
  if (contentMetadata) normalizedRemote.content = stripManagedContent(remote.content);
  return {
    remote: normalizedRemote,
    metadata: normalizedMetadata,
    tasks,
    userContent: normalizedMetadata.userContent ?? remoteContent,
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
