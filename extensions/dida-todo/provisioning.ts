import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withHostLock } from "./host-lock.js";
import { DEFAULT_CONFIG_PATH, normalizeCwd, resolveBinding } from "./config.js";
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

interface AvailableBindingInput extends ProvisioningInput {
  config: DidaTodoConfig;
}

export interface AvailableBindingResult {
  binding?: ProjectBinding;
  config: DidaTodoConfig;
  repaired: boolean;
}

function cleanName(value: string): string {
  const cleaned = value.trim().replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  if (!cleaned) throw new Error("滴答分组名称不能为空");
  return cleaned;
}

export function deriveBindingIdentity(
  cwd: string,
  projectName: string,
  tmuxTarget?: string,
): BindingIdentity {
  const normalizedCwd = normalizeCwd(cwd);
  const cleanProjectName = cleanName(projectName);
  return {
    projectName: cleanProjectName,
    bindingKey: tmuxTarget ? `tmux:${tmuxTarget}` : `cwd:${normalizedCwd}`,
    cwdKey: `cwd:${normalizedCwd}`,
    label: cleanProjectName,
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
      const existingCwd = bindings.find((candidate) => candidate.key === identity.cwdKey);
      if (!existingCwd || existingCwd.projectId === project.id) {
        bindings = upsertBinding(bindings, {
          key: identity.cwdKey,
          projectId: project.id,
          cwd: normalizedCwd,
          label: identity.label,
        });
      }
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

export async function resolveAvailableProjectBinding(input: AvailableBindingInput): Promise<AvailableBindingResult> {
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH;
  const projects = openProjects(await input.gateway.listProjects(input.signal));
  const projectIds = new Set(projects.map((project) => project.id));
  const binding = resolveBinding(input.config, input.cwd, input.tmuxTarget, projectIds);
  if (!binding) return { config: input.config, repaired: false };

  const tmuxKey = input.tmuxTarget ? `tmux:${input.tmuxTarget}` : undefined;
  const exactTmux = tmuxKey ? input.config.bindings.find((candidate) => candidate.key === tmuxKey) : undefined;
  if (!input.tmuxTarget || (exactTmux?.projectId === binding.projectId && projectIds.has(exactTmux.projectId))) {
    return { binding, config: input.config, repaired: false };
  }

  const project = projects.find((candidate) => candidate.id === binding.projectId);
  if (!project) return { config: input.config, repaired: false };
  const identity = {
    ...deriveBindingIdentity(input.cwd, project.name, input.tmuxTarget),
    label: binding.label ?? project.name,
  };
  const persisted = await persistBinding(configPath, input.config, identity, project, input.cwd, input.tmuxTarget);
  return { ...persisted, repaired: true };
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
  const identity = deriveBindingIdentity(input.cwd, project.name, input.tmuxTarget);
  const persisted = await persistBinding(configPath, config, identity, project, input.cwd, input.tmuxTarget);
  return { ...persisted, project, createdProject: false };
}

export async function provisionPromptedProject(
  input: ProvisioningInput & { prompt: () => Promise<string | undefined> },
): Promise<ProvisioningResult | undefined> {
  const rawProjectName = (await input.prompt())?.trim();
  if (!rawProjectName) return undefined;
  const projectName = cleanName(rawProjectName);
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH;
  return withHostLock(`provision:${configPath}:prompt:${projectName}`, async () => {
    const config = await readConfig(configPath);
    const projects = openProjects(await input.gateway.listProjects(input.signal));
    const matches = projects.filter((project) => project.name.trim() === projectName);
    if (matches.length > 1) {
      throw new Error(`存在 ${matches.length} 个同名清单“${projectName}”，请改用 projectId 绑定`);
    }
    const createdProject = matches.length === 0;
    const project = matches[0] ?? await input.gateway.createProject(projectName, input.signal);
    const identity = deriveBindingIdentity(input.cwd, projectName, input.tmuxTarget);
    const persisted = await persistBinding(configPath, config, identity, project, input.cwd, input.tmuxTarget);
    return { ...persisted, project, createdProject };
  });
}
