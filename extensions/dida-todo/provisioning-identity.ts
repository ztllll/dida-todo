import { hostname } from "node:os";

export interface ImRouteIdentity {
  channel: string;
  routeName: string;
}

export interface ProvisioningNamespace {
  hostName?: string;
  imRoute?: ImRouteIdentity;
}

export interface InventoryRoute {
  name?: unknown;
  channel?: unknown;
  tmux_target?: unknown;
  tmux_session?: unknown;
  tmux_window?: unknown;
  tmux_pane?: unknown;
}

function cleanPart(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/[\[\]\u0000-\u001f]/g, "").slice(0, 48);
  return cleaned || undefined;
}
function cleanTopicPart(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").slice(0, 120);
  return cleaned || undefined;
}

export function normalizeTopicName(value: string): string {
  return cleanTopicPart(value)?.normalize("NFKC").toLocaleLowerCase("en-US") ?? "";
}

export function topicBindingKey(value: string): string {
  const normalized = normalizeTopicName(value);
  if (!normalized) throw new Error("无法从当前话题推导滴答清单绑定键");
  return `topic:${normalized}`;
}


export function localHostName(): string {
  return cleanPart(hostname()) ?? "unknown-host";
}

export function inventoryRoutes(value: unknown): InventoryRoute[] {
  if (Array.isArray(value)) return value as InventoryRoute[];
  if (!value || typeof value !== "object") return [];
  const routes = (value as { routes?: unknown }).routes;
  return Array.isArray(routes) ? routes as InventoryRoute[] : [];
}

export function routeTarget(route: InventoryRoute): string | undefined {
  if (typeof route.tmux_target === "string" && route.tmux_target.trim()) return route.tmux_target.trim();
  if (typeof route.tmux_session !== "string") return undefined;
  const window = Number(route.tmux_window ?? 0);
  const pane = Number(route.tmux_pane ?? 0);
  if (!Number.isInteger(window) || !Number.isInteger(pane)) return undefined;
  return `${route.tmux_session}:${window}.${pane}`;
}

export function findImRouteIdentity(value: unknown, tmuxTarget: string): ImRouteIdentity | undefined {
  const matches = inventoryRoutes(value).filter((route) => routeTarget(route) === tmuxTarget);
  if (matches.length !== 1) return undefined;
  const route = matches[0]!;
  if (typeof route.name !== "string" || typeof route.channel !== "string") return undefined;
  const routeName = cleanTopicPart(route.name);
  const channel = cleanPart(route.channel.toLowerCase());
  return routeName && channel ? { routeName, channel } : undefined;
}

export function topicProjectName(baseName: string, namespace: ProvisioningNamespace): string {
  return cleanTopicPart(namespace.imRoute?.routeName ?? baseName) ?? "Dida Todo";
}
