import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PersistedWorkMetadata, WorkMetadata } from "./domain.js";
import { withHostLock } from "./host-lock.js";
import { migrateLegacyLocalFile } from "./local-file-migration.js";
import { migrateWorkMetadata } from "./work-lifecycle.js";

interface StoredWorkState {
  metadata: WorkMetadata;
  updatedAt: string;
}

interface PersistedStoredWorkState {
  metadata: PersistedWorkMetadata;
  updatedAt: string;
}

export interface AcceptanceLink {
  sourceWorkId: string;
  sourceOccurrence?: string;
  reworkWorkId?: string;
}

interface StoredAcceptanceLink extends AcceptanceLink {
  updatedAt: string;
}

interface StateFile {
  schemaVersion: 1;
  works: Record<string, StoredWorkState>;
  acceptances: Record<string, StoredAcceptanceLink>;
}

interface PersistedStateFile {
  schemaVersion: 1;
  works: Record<string, PersistedStoredWorkState>;
  acceptances: Record<string, StoredAcceptanceLink>;
}

export interface WorkStateStore {
  get(projectId: string, workId: string): Promise<WorkMetadata | undefined>;
  set(projectId: string, workId: string, metadata: WorkMetadata): Promise<void>;
  delete(projectId: string, workId: string): Promise<void>;
  getAcceptance(projectId: string, acceptanceId: string): Promise<AcceptanceLink | undefined>;
  findAcceptance(projectId: string, sourceWorkId: string, sourceOccurrence?: string): Promise<string | undefined>;
  setAcceptance(projectId: string, acceptanceId: string, link: AcceptanceLink): Promise<void>;
  setRework(projectId: string, acceptanceId: string, reworkWorkId: string): Promise<void>;
}

function cloneMetadata(metadata: WorkMetadata): WorkMetadata {
  return structuredClone(metadata);
}

function emptyState(): StateFile {
  return { schemaVersion: 1, works: {}, acceptances: {} };
}

export const DEFAULT_WORK_STATE_PATH = join(homedir(), ".local", "state", "omp-dida-todo", "work-state.json");
export const LEGACY_WORK_STATE_PATH = join(homedir(), ".local", "state", "pi-dida-todo", "work-state.json");

export function defaultWorkStatePath(): string {
  return DEFAULT_WORK_STATE_PATH;
}

export function resolveWorkStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OMP_DIDA_TODO_STATE_PATH?.trim() || DEFAULT_WORK_STATE_PATH;
}

function workKey(projectId: string, workId: string): string {
  return `${projectId}:${workId}`;
}

export class JsonWorkStateStore implements WorkStateStore {
  private writeChain = Promise.resolve();
  private readonly path: string;
  private readonly migrateLegacyState: boolean;
  private legacyMigrationChecked = false;

  constructor(path?: string) {
    const configuredPath = process.env.OMP_DIDA_TODO_STATE_PATH?.trim();
    this.path = path ?? resolveWorkStatePath();
    this.migrateLegacyState = path === undefined && !configuredPath;
  }

  async get(projectId: string, workId: string): Promise<WorkMetadata | undefined> {
    await this.writeChain;
    const stored = (await this.load()).works[workKey(projectId, workId)];
    return stored ? cloneMetadata(stored.metadata) : undefined;
  }

  async set(projectId: string, workId: string, metadata: WorkMetadata): Promise<void> {
    await this.mutate((state) => {
      state.works[workKey(projectId, workId)] = {
        metadata: cloneMetadata(metadata),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async delete(projectId: string, workId: string): Promise<void> {
    await this.mutate((state) => {
      delete state.works[workKey(projectId, workId)];
    });
  }

  async getAcceptance(projectId: string, acceptanceId: string): Promise<AcceptanceLink | undefined> {
    await this.writeChain;
    const link = (await this.load()).acceptances[workKey(projectId, acceptanceId)];
    if (!link) return undefined;
    const { updatedAt: _updatedAt, ...value } = link;
    return structuredClone(value);
  }

  async findAcceptance(projectId: string, sourceWorkId: string, sourceOccurrence?: string): Promise<string | undefined> {
    await this.writeChain;
    const state = await this.load();
    const prefix = `${projectId}:`;
    for (const [key, link] of Object.entries(state.acceptances)) {
      if (key.startsWith(prefix) && link.sourceWorkId === sourceWorkId && link.sourceOccurrence === sourceOccurrence) {
        return key.slice(prefix.length);
      }
    }
    return undefined;
  }

  async setAcceptance(projectId: string, acceptanceId: string, link: AcceptanceLink): Promise<void> {
    await this.mutate((state) => {
      state.acceptances[workKey(projectId, acceptanceId)] = {
        ...structuredClone(link),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async setRework(projectId: string, acceptanceId: string, reworkWorkId: string): Promise<void> {
    await this.mutate((state) => {
      const key = workKey(projectId, acceptanceId);
      const current = state.acceptances[key];
      if (!current) throw new Error(`验收关联不存在: ${acceptanceId}`);
      state.acceptances[key] = { ...current, reworkWorkId, updatedAt: new Date().toISOString() };
    });
  }

  private async mutate(change: (state: StateFile) => void): Promise<void> {
    const operation = this.writeChain.then(() => withHostLock(`state-store:${this.path}`, async () => {
      await this.migrateLegacyStateIfNeeded();
      const { state } = await this.readState();
      change(state);
      await this.write(state);
    }));
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async load(): Promise<StateFile> {
    return withHostLock(`state-store:${this.path}`, async () => {
      await this.migrateLegacyStateIfNeeded();
      const { state, migrated } = await this.readState();
      if (migrated) await this.write(state);
      return state;
    });
  }

  private async migrateLegacyStateIfNeeded(): Promise<void> {
    if (!this.migrateLegacyState || this.legacyMigrationChecked) return;
    await migrateLegacyLocalFile(LEGACY_WORK_STATE_PATH, this.path);
    this.legacyMigrationChecked = true;
  }

  private async readState(): Promise<{ state: StateFile; migrated: boolean }> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<PersistedStateFile>;
      if (value.schemaVersion !== 1 || !value.works || typeof value.works !== "object" || Array.isArray(value.works)) {
        throw new Error("state schema invalid");
      }
      let migrated = false;
      const works: StateFile["works"] = {};
      for (const [key, stored] of Object.entries(value.works as PersistedStateFile["works"])) {
        const metadata = migrateWorkMetadata(stored.metadata);
        if (stored.metadata.schemaVersion !== 3 || stored.metadata.kind !== "dida-todo-work") migrated = true;
        works[key] = { metadata, updatedAt: stored.updatedAt };
      }
      return {
        state: {
          schemaVersion: 1,
          works,
          acceptances: value.acceptances && typeof value.acceptances === "object" && !Array.isArray(value.acceptances)
            ? structuredClone(value.acceptances) as StateFile["acceptances"]
            : {},
        },
        migrated,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyState(), migrated: false };
      throw new Error(`无法读取 dida-todo 本机状态库 ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async write(state: StateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const digest = createHash("sha256").update(`${process.pid}:${randomUUID()}`).digest("hex").slice(0, 12);
    const temporary = `${this.path}.${digest}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export class MemoryWorkStateStore implements WorkStateStore {
  private readonly works = new Map<string, WorkMetadata>();
  private readonly acceptances = new Map<string, AcceptanceLink>();

  async get(projectId: string, workId: string): Promise<WorkMetadata | undefined> {
    const metadata = this.works.get(workKey(projectId, workId));
    return metadata ? cloneMetadata(metadata) : undefined;
  }

  async set(projectId: string, workId: string, metadata: WorkMetadata): Promise<void> {
    this.works.set(workKey(projectId, workId), cloneMetadata(metadata));
  }

  async delete(projectId: string, workId: string): Promise<void> {
    this.works.delete(workKey(projectId, workId));
  }

  async getAcceptance(projectId: string, acceptanceId: string): Promise<AcceptanceLink | undefined> {
    const link = this.acceptances.get(workKey(projectId, acceptanceId));
    return link ? structuredClone(link) : undefined;
  }

  async findAcceptance(projectId: string, sourceWorkId: string, sourceOccurrence?: string): Promise<string | undefined> {
    const prefix = `${projectId}:`;
    for (const [key, link] of this.acceptances) {
      if (key.startsWith(prefix) && link.sourceWorkId === sourceWorkId && link.sourceOccurrence === sourceOccurrence) {
        return key.slice(prefix.length);
      }
    }
    return undefined;
  }

  async setAcceptance(projectId: string, acceptanceId: string, link: AcceptanceLink): Promise<void> {
    this.acceptances.set(workKey(projectId, acceptanceId), structuredClone(link));
  }

  async setRework(projectId: string, acceptanceId: string, reworkWorkId: string): Promise<void> {
    const key = workKey(projectId, acceptanceId);
    const current = this.acceptances.get(key);
    if (!current) throw new Error(`验收关联不存在: ${acceptanceId}`);
    this.acceptances.set(key, { ...current, reworkWorkId });
  }
}
