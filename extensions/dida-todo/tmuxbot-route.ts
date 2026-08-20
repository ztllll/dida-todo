import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findImRouteIdentity, localHostName, type ProvisioningNamespace } from "./provisioning-identity.js";

const MAX_INVENTORY_BYTES = 1024 * 1024;

export function canAutoProvisionNamespace(namespace: ProvisioningNamespace): boolean {
  return namespace.imRoute !== undefined;
}

export function resolveTmuxbotBindingsPath(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return environment.TMUXBOT_BINDINGS?.trim() || join(home, "tmuxbot", "bindings.yaml");
}

export async function detectProvisioningNamespace(
  pi: ExtensionAPI,
  tmuxTarget: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  read: (path: string, encoding: BufferEncoding) => Promise<string> = readFile,
): Promise<ProvisioningNamespace> {
  const hostName = localHostName();
  if (!tmuxTarget) return { hostName };
  try {
    const bindings = await read(resolveTmuxbotBindingsPath(environment, home), "utf8");
    if (Buffer.byteLength(bindings, "utf8") > MAX_INVENTORY_BYTES) return { hostName };
    const imRoute = findImRouteIdentity(parse(bindings), tmuxTarget);
    return { hostName, ...(imRoute ? { imRoute } : {}) };
  } catch {
    return { hostName };
  }
}
