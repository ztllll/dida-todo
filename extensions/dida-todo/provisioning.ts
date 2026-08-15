import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { withHostLock } from "./host-lock.js";
import { migrateDefaultConfigFile, normalizeCwd, resolveConfigPath } from "./config.js";
import type { DidaProject, DidaTodoConfig, ProjectBinding } from "./domain.js";
import { normalizeTopicName, topicBindingKey, topicProjectName, type ProvisioningNamespace } from "./provisioning-identity.js";

export interface ProjectProvisioningGateway {
  listProjects(signal?: AbortSignal): Promise<DidaProject[]>;
  createProject(name: string, signal?: AbortSignal): Promise<DidaProject>;
}

export interface BindingIdentity {
  projectName: string;
  bindingKey: string;
  cwdKey: string;
  topicKey: string;
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
  namespace?: ProvisioningNamespace;
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

export function deriveBindingIdentity(
  cwd: string,
  tmuxTarget?: string,
  namespace: ProvisioningNamespace = {},
): BindingIdentity {
  const normalizedCwd = normalizeCwd(cwd);
  const tmuxSession = tmuxTarget?.split(":", 1)[0]?.trim();
  const baseName = cleanName(tmuxSession || basename(normalizedCwd) || "Dida Todo");
  const projectName = cleanName(topicProjectName(baseName, namespace));
  return {
    projectName,
    topicKey: topicBindingKey(projectName),
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

function sameBinding(left: ProjectBinding, right: ProjectBinding): boolean {
  return left.key === right.key && left.projectId === right.projectId && left.cwd === right.cwd && left.label === right.label;
}

function upsertBinding(bindings: ProjectBinding[], binding: ProjectBinding): ProjectBinding[] {
  const index = bindings.findIndex((candidate) => candidate.key === binding.key);
  if (index < 0) return [...bindings, binding];
  if (sameBinding(bindings[index]!, binding)) return bindings;
  const next = [...bindings];
  next[index] = binding;
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
  return withHostLock(`config:${path}`, async () => {
    const latest = await readConfig(path);
    const normalizedCwd = normalizeCwd(cwd);
    const topicBinding: ProjectBinding = {
      key: identity.topicKey,
      projectId: project.id,
      label: identity.label,
    };
    const primary: ProjectBinding = {
      key: identity.bindingKey,
      projectId: project.id,
      cwd: normalizedCwd,
      label: identity.label,
    };
    let bindings = upsertBinding(latest.bindings, topicBinding);
    bindings = upsertBinding(bindings, primary);
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
    const unchanged = JSON.stringify(next) === JSON.stringify(latest);
    if (!unchanged) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const temporary = resolve(dir, `.config-${process.pid}-${Date.now()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
    }
    return { config: next, binding: topicBinding };
  });
}

function openProjects(projects: DidaProject[]): DidaProject[] {
  return projects.filter((project) => project.closed !== true);
}

export async function ensureProjectBinding(input: ProvisioningInput): Promise<ProvisioningResult> {
  const configPath = input.configPath ?? resolveConfigPath();
  if (input.configPath === undefined && !process.env.OMP_DIDA_TODO_CONFIG_PATH?.trim()) await migrateDefaultConfigFile();
  const identity = deriveBindingIdentity(input.cwd, input.tmuxTarget, input.namespace);
  return withHostLock(`provision:${configPath}:${identity.topicKey}`, async () => {
    const config = await readConfig(configPath);
    const projects = openProjects(await input.gateway.listProjects(input.signal));
    const matches = projects.filter((project) => normalizeTopicName(project.name) === normalizeTopicName(identity.projectName));
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
  const configPath = input.configPath ?? resolveConfigPath();
  if (input.configPath === undefined && !process.env.OMP_DIDA_TODO_CONFIG_PATH?.trim()) await migrateDefaultConfigFile();
  const config = await readConfig(configPath);
  const projects = openProjects(await input.gateway.listProjects(input.signal));
  let project: DidaProject | undefined;
  if (input.projectId) project = projects.find((candidate) => candidate.id === input.projectId);
  else {
    const matches = projects.filter((candidate) => normalizeTopicName(candidate.name) === normalizeTopicName(input.projectName ?? ""));
    if (matches.length > 1) throw new Error(`存在 ${matches.length} 个同名清单“${input.projectName}”，请改用 projectId`);
    project = matches[0];
  }
  if (!project) throw new Error("未找到要绑定的滴答清单");
  const identity = { ...deriveBindingIdentity(input.cwd, input.tmuxTarget, input.namespace), projectName: project.name, label: project.name };
  const persisted = await persistBinding(configPath, config, identity, project, input.cwd, input.tmuxTarget);
  return { ...persisted, project, createdProject: false };
}

export async function ensureExistingBindingAliases(
  input: Omit<ProvisioningInput, "gateway" | "signal"> & { binding: ProjectBinding },
): Promise<{ binding: ProjectBinding; config: DidaTodoConfig }> {
  const configPath = input.configPath ?? resolveConfigPath();
  if (input.configPath === undefined && !process.env.OMP_DIDA_TODO_CONFIG_PATH?.trim()) await migrateDefaultConfigFile();
  const config = await readConfig(configPath);
  const identity = deriveBindingIdentity(input.cwd, input.tmuxTarget, input.namespace);
  return persistBinding(
    configPath,
    config,
    identity,
    { id: input.binding.projectId, name: identity.projectName },
    input.cwd,
    input.tmuxTarget,
  );
}
