import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkMetadata } from "./domain.js";
import { withHostLock } from "./host-lock.js";

interface StoredWorkState {
  metadata: WorkMetadata;
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

export function defaultWorkStatePath(): string {
  return join(homedir(), ".local", "state", "pi-dida-todo", "work-state.json");
}

function workKey(projectId: string, workId: string): string {
  return `${projectId}:${workId}`;
}

export class JsonWorkStateStore implements WorkStateStore {
  private writeChain = Promise.resolve();

  constructor(private readonly path = defaultWorkStatePath()) {}

  async get(projectId: string, workId: string): Promise<WorkMetadata | undefined> {
    await this.writeChain;
    const stored = (await this.read()).works[workKey(projectId, workId)];
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
    const link = (await this.read()).acceptances[workKey(projectId, acceptanceId)];
    if (!link) return undefined;
    const { updatedAt: _updatedAt, ...value } = link;
    return structuredClone(value);
  }

  async findAcceptance(projectId: string, sourceWorkId: string, sourceOccurrence?: string): Promise<string | undefined> {
    await this.writeChain;
    const state = await this.read();
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
      const state = await this.read();
      change(state);
      await this.write(state);
    }));
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<StateFile> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<StateFile>;
      if (value.schemaVersion !== 1 || !value.works || typeof value.works !== "object" || Array.isArray(value.works)) {
        throw new Error("state schema invalid");
      }
      return {
        schemaVersion: 1,
        works: structuredClone(value.works) as StateFile["works"],
        acceptances: value.acceptances && typeof value.acceptances === "object" && !Array.isArray(value.acceptances)
          ? structuredClone(value.acceptances) as StateFile["acceptances"]
          : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
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
