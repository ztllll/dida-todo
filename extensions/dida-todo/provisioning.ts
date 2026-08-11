import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withHostLock } from "./host-lock.js";
import { DEFAULT_CONFIG_PATH, normalizeCwd } from "./config.js";
import type { DidaProject, DidaTodoConfig, ProjectBinding } from "./domain.js";

export interface ProjectProvisioningGateway {
  listProjects(signal?: AbortSignal): Promise<DidaProject[]>;
  createProject(name: string, signal?: AbortSignal): Promise<DidaProject>;
}

export interface BindingIdentity {
  projectName: string;
  bindingKey: string;
  cwdKey: string;
  label: string;
}

export interface ProvisioningResult {
  binding: ProjectBinding;
  project: DidaProject;
  createdProject: boolean;
  config: DidaTodoConfig;
}

interface ProvisioningInput {
  gateway: ProjectProvisioningGateway;
  cwd: string;
  tmuxTarget?: string;
  configPath?: string;
  signal?: AbortSignal;
}

interface ExplicitBindingInput extends ProvisioningInput {
  projectId?: string;
  projectName?: string;
}

function cleanName(value: string): string {
  const cleaned = value.trim().replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  if (!cleaned) throw new Error("无法从当前项目推导滴答清单名称");
  return cleaned;
}

export function deriveBindingIdentity(cwd: string, tmuxTarget?: string): BindingIdentity {
  const normalizedCwd = normalizeCwd(cwd);
  const tmuxSession = tmuxTarget?.split(":", 1)[0]?.trim();
  const projectName = cleanName(tmuxSession || basename(normalizedCwd) || "Pi Todo");
  return {
    projectName,
    bindingKey: tmuxTarget ? `tmux:${tmuxTarget}` : `cwd:${normalizedCwd}`,
    cwdKey: `cwd:${normalizedCwd}`,
    label: projectName,
  };
}

export function isDidaAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /未找到 access token|请先运行 [`']?dida auth login|未登录/i.test(message);
}

async function readConfig(path: string): Promise<DidaTodoConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<DidaTodoConfig>;
    return { ...value, bindings: Array.isArray(value.bindings) ? value.bindings : [] } as DidaTodoConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [] };
    throw error;
  }
}

function upsertBinding(bindings: ProjectBinding[], binding: ProjectBinding): ProjectBinding[] {
  const next = bindings.filter((candidate) => candidate.key !== binding.key);
  next.push(binding);
  return next;
}

async function persistBinding(
  path: string,
  config: DidaTodoConfig,
  identity: BindingIdentity,
  project: DidaProject,
  cwd: string,
  tmuxTarget?: string,
): Promise<{ config: DidaTodoConfig; binding: ProjectBinding }> {
  return withHostLock(`config:${path}`, () => withFileMutationQueue(path, async () => {
    const latest = await readConfig(path);
    const normalizedCwd = normalizeCwd(cwd);
    const primary: ProjectBinding = {
      key: identity.bindingKey,
      projectId: project.id,
      cwd: normalizedCwd,
      label: identity.label,
    };
    let bindings = upsertBinding(latest.bindings, primary);
    if (tmuxTarget) {
      bindings = upsertBinding(bindings, {
        key: identity.cwdKey,
        projectId: project.id,
        cwd: normalizedCwd,
        label: identity.label,
      });
    }
    const next: DidaTodoConfig = { ...config, ...latest, bindings };
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const temporary = resolve(dir, `.config-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    return { config: next, binding: primary };
  }));
}

function openProjects(projects: DidaProject[]): DidaProject[] {
  return projects.filter((project) => project.closed !== true);
}

export async function ensureProjectBinding(input: ProvisioningInput): Promise<ProvisioningResult> {
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH;
  const identity = deriveBindingIdentity(input.cwd, input.tmuxTarget);
  return withHostLock(`provision:${configPath}:${identity.projectName}`, async () => {
    const config = await readConfig(configPath);
    const projects = openProjects(await input.gateway.listProjects(input.signal));
    const matches = projects.filter((project) => project.name.trim() === identity.projectName);
    if (matches.length > 1) {
      throw new Error(`存在 ${matches.length} 个同名清单“${identity.projectName}”，为避免误绑定，请让 LLM 按 projectId 显式绑定`);
    }
    const createdProject = matches.length === 0;
    const project = matches[0] ?? await input.gateway.createProject(identity.projectName, input.signal);
    const persisted = await persistBinding(configPath, config, identity, project, input.cwd, input.tmuxTarget);
    return { ...persisted, project, createdProject };
  });
}

export async function bindExistingProject(input: ExplicitBindingInput): Promise<ProvisioningResult> {
  if (!input.projectId && !input.projectName?.trim()) throw new Error("projectId 或 projectName 至少提供一个");
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readConfig(configPath);
  const projects = openProjects(await input.gateway.listProjects(input.signal));
  let project: DidaProject | undefined;
  if (input.projectId) project = projects.find((candidate) => candidate.id === input.projectId);
  else {
    const matches = projects.filter((candidate) => candidate.name.trim() === input.projectName?.trim());
    if (matches.length > 1) throw new Error(`存在 ${matches.length} 个同名清单“${input.projectName}”，请改用 projectId`);
    project = matches[0];
  }
  if (!project) throw new Error("未找到要绑定的滴答清单");
  const identity = { ...deriveBindingIdentity(input.cwd, input.tmuxTarget), projectName: project.name, label: project.name };
  const persisted = await persistBinding(configPath, config, identity, project, input.cwd, input.tmuxTarget);
  return { ...persisted, project, createdProject: false };
}
