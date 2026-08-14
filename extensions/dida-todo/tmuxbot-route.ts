import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { findImRouteIdentity, localHostName, type ProvisioningNamespace } from "./provisioning-identity.js";

const MAX_INVENTORY_BYTES = 1024 * 1024;

export async function detectProvisioningNamespace(
  pi: ExtensionAPI,
  tmuxTarget: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProvisioningNamespace> {
  const hostName = localHostName();
  const bindings = environment.TMUXBOT_BINDINGS?.trim();
  if (!tmuxTarget || !bindings) return { hostName };
  try {
    const result = await pi.exec("tmuxbot", ["admin", "--file", bindings, "inventory", "--json"], { timeout: 5000 });
    if (result.code !== 0 || Buffer.byteLength(result.stdout, "utf8") > MAX_INVENTORY_BYTES) return { hostName };
    const inventory = JSON.parse(result.stdout) as unknown;
    const imRoute = findImRouteIdentity(inventory, tmuxTarget);
    return { hostName, ...(imRoute ? { imRoute } : {}) };
  } catch {
    return { hostName };
  }
}
