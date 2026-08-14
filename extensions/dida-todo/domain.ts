export type TaskStatus = "pending" | "in_progress" | "completed" | "skipped" | "deleted";
export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  itemId?: string;
}

export interface DidaChecklistItem {
  id?: string;
  title: string;
  status?: number;
  completedTime?: string;
  isAllDay?: boolean;
  sortOrder?: number;
  startDate?: string;
  timeZone?: string;
  [key: string]: unknown;
}

export interface DidaTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  status: number;
  priority: number;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  reminders?: string[];
  repeatFlag?: string;
  sortOrder?: number;
  completedTime?: string;
  createdTime?: string;
  modifiedTime?: string;
  etag?: string;
  kind?: string;
  tags?: string[];
  items?: DidaChecklistItem[];
  [key: string]: unknown;
}

export interface DidaProject {
  id: string;
  name: string;
  closed?: boolean;
  kind?: string;
  viewMode?: string;
  permission?: string;
}

export interface DidaProjectData {
  project: DidaProject;
  tasks: DidaTask[];
  columns: Array<Record<string, unknown>>;
}

interface WorkMetadataFields {
  bindingKey: string;
  nextId: number;
  activeTaskId?: number;
  tasks: Task[];
  sessionIds?: string[];
  tmuxTarget?: string;
  cwd?: string;
}

export interface WorkMetadataV1 extends WorkMetadataFields {
  schemaVersion: 1;
  kind: "pi-todo-work";
}

export type LegacyWorkOrigin = "pi" | "dida";
export type WorkOrigin = "agent" | "dida";
export type DidaWorkType = "direct" | "checklist";
export type DidaWorkPriority = "low" | "medium" | "high";
export type WorkLifecycleState = "draft" | "claimed" | "running" | "ready_for_acceptance" | "finalized";

interface LifecycleWorkMetadataFields extends WorkMetadataFields {
  lifecycle: WorkLifecycleState;
  workType?: DidaWorkType;
  userDescription?: string;
  userContent?: string;
  workTypeMigratedFromLegacy?: boolean;
  execution?: {
    occurrence?: string;
    claimedAt: string;
    owner?: { hostId: string; sessionId: string; leaseUntil?: string };
  };
  finalization?: {
    occurrence?: string;
    acceptanceId?: string;
    commentWritten?: boolean;
    sourceCompleted?: boolean;
  };
}

export interface WorkMetadataV2 extends LifecycleWorkMetadataFields {
  schemaVersion: 2;
  kind: "pi-todo-work";
  origin: LegacyWorkOrigin;
  migratedFromVersion?: 1;
}

export interface WorkMetadataV3 extends LifecycleWorkMetadataFields {
  schemaVersion: 3;
  kind: "dida-todo-work";
  origin: WorkOrigin;
  migratedFromVersion?: 1 | 2;
}

/** Accepted only when decoding persisted Pi metadata. Runtime work is always V3. */
export type LegacyWorkMetadata = WorkMetadataV1 | WorkMetadataV2;
export type PersistedWorkMetadata = LegacyWorkMetadata | WorkMetadataV3;
export type WorkMetadata = WorkMetadataV3;

export interface WorkTask {
  remote: DidaTask;
  metadata: WorkMetadata;
  tasks: Task[];
  userContent: string;
}

export interface ProjectBinding {
  key: string;
  projectId: string;
  cwd?: string;
  label?: string;
}

export interface DidaTodoConfig {
  didaCommand?: string;
  bindings: ProjectBinding[];
  maxWidgetLines?: number;
  collapseKey?: string;
  autoResumeSingle?: boolean;
  autoProvisionProject?: boolean;
  pollIntervalMinutes?: number;
}

export interface TodoScope {
  binding: ProjectBinding;
  bindingKey: string;
  cwd: string;
  tmuxTarget?: string;
  sessionId: string;
}
