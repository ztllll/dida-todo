export const DIDA_WORK_TAG = "dida-todo-work";
export const DIDA_ACCEPTANCE_TAG = "dida-todo-acceptance";
export const DIDA_REWORK_TAG = "dida-todo-rework";
export const DIDA_REMINDER_TAG = "dida-todo-reminder";

type ManagedTag =
  | typeof DIDA_WORK_TAG
  | typeof DIDA_ACCEPTANCE_TAG
  | typeof DIDA_REWORK_TAG
  | typeof DIDA_REMINDER_TAG;

const LEGACY_TAG_BY_CURRENT: Record<ManagedTag, string> = {
  [DIDA_WORK_TAG]: "pi-todo",
  [DIDA_ACCEPTANCE_TAG]: "pi-todo-acceptance",
  [DIDA_REWORK_TAG]: "pi-todo-rework",
  [DIDA_REMINDER_TAG]: "pi-todo-reminder",
};

const RESERVED_DIDA_TAGS: Record<string, true> = {
  [DIDA_WORK_TAG]: true,
  [DIDA_ACCEPTANCE_TAG]: true,
  [DIDA_REWORK_TAG]: true,
  [DIDA_REMINDER_TAG]: true,
};

const RESERVED_LEGACY_TAGS: Record<string, true> = {
  "pi-todo": true,
  "pi-todo-acceptance": true,
  "pi-todo-rework": true,
  "pi-todo-reminder": true,
};

export function hasManagedTag(tags: readonly string[] | undefined, tag: ManagedTag): boolean {
  return tags?.includes(tag) === true || tags?.includes(LEGACY_TAG_BY_CURRENT[tag]) === true;
}

export function hasDidaAcceptanceTag(tags: readonly string[] | undefined): boolean {
  return hasManagedTag(tags, DIDA_ACCEPTANCE_TAG);
}

export function hasDidaReminderTag(tags: readonly string[] | undefined): boolean {
  return hasManagedTag(tags, DIDA_REMINDER_TAG);
}

/** Preserves user tags while replacing every legacy/current Dida reserved tag. */
export function managedTags(tags: readonly string[] | undefined, ...nextTags: ManagedTag[]): string[] {
  return [
    ...(tags ?? []).filter((tag) => !RESERVED_DIDA_TAGS[tag] && !RESERVED_LEGACY_TAGS[tag]),
    ...nextTags,
  ];
}

export function managedWorkTags(tags: readonly string[] | undefined): string[] {
  if (hasManagedTag(tags, DIDA_REWORK_TAG)) {
    return managedTags(tags, DIDA_WORK_TAG, DIDA_REWORK_TAG);
  }
  return managedTags(tags, DIDA_WORK_TAG);
}
