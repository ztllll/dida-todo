import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, normalize, resolve } from "node:path";
import type { DidaTodoConfig, ProjectBinding } from "./domain.js";

export const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config", "pi-dida-todo", "config.json");
const require = createRequire(import.meta.url);
export const BUNDLED_DIDA_COMMAND = require.resolve("@suibiji/dida-cli/dist/index.js");
export const DEFAULT_MAX_WIDGET_LINES = 12;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";

export function normalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return normalize(resolved).replace(/\/$/, "");
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<DidaTodoConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bindings: [] };
    }
    throw new Error(`无法读取滴答 Todo 配置 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`滴答 Todo 配置必须是 JSON 对象: ${path}`);
  const value = raw as Partial<DidaTodoConfig>;
  if (!Array.isArray(value.bindings)) throw new Error(`滴答 Todo 配置缺少 bindings 数组: ${path}`);
  if (
    value.autoProvisionProject !== undefined && typeof value.autoProvisionProject !== "boolean"
  ) {
    throw new Error("autoProvisionProject 必须是布尔值");
  }
  if (
    value.pollIntervalMinutes !== undefined &&
    (!Number.isInteger(value.pollIntervalMinutes) || value.pollIntervalMinutes < 1 || value.pollIntervalMinutes > 1440)
  ) {
    throw new Error("pollIntervalMinutes 必须是 1 到 1440 的整数分钟");
  }
  for (const [index, binding] of value.bindings.entries()) {
    if (!binding || typeof binding.key !== "string" || typeof binding.projectId !== "string") {
      throw new Error(`bindings[${index}] 必须包含字符串 key 和 projectId`);
    }
    if (binding.cwd !== undefined && typeof binding.cwd !== "string") {
      throw new Error(`bindings[${index}].cwd 必须是字符串`);
    }
  }
  return value as DidaTodoConfig;
}

export function bindingKeyFor(cwd: string, tmuxTarget?: string): string {
  return tmuxTarget ? `tmux:${tmuxTarget}` : `cwd:${normalizeCwd(cwd)}`;
}

export function resolveBinding(config: DidaTodoConfig, cwd: string, tmuxTarget?: string): ProjectBinding | undefined {
  const normalizedCwd = normalizeCwd(cwd);
  if (tmuxTarget) {
    const tmuxKey = `tmux:${tmuxTarget}`;
    const match = config.bindings.find((binding) => binding.key === tmuxKey);
    if (match) {
      if (match.cwd && normalizeCwd(match.cwd) !== normalizedCwd) return undefined;
      return match;
    }
  }
  const cwdKey = `cwd:${normalizedCwd}`;
  return config.bindings.find((binding) => binding.key === cwdKey);
}

export function resolveDidaCommand(config: DidaTodoConfig): string {
  const command = config.didaCommand?.trim();
  if (!command) return BUNDLED_DIDA_COMMAND;
  if (command.includes("\0")) throw new Error("didaCommand 包含非法空字符");
  if (command.includes("/") && !isAbsolute(command)) return resolve(command);
  return command;
}
