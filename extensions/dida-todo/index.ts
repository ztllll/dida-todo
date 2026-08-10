import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_MAX_WIDGET_LINES,
  bindingKeyFor,
  loadConfig,
  resolveBinding,
  resolveDidaCommand,
} from "./config.js";
import { registerCommands } from "./commands.js";
import { DidaCliGateway } from "./gateway.js";
import { TodoOverlay } from "./overlay.js";
import { DidaTodoRepository } from "./repository.js";
import {
  clearActiveSession,
  getActiveRuntime,
  getActiveTasks,
  getSessionRuntime,
  removeSessionRuntime,
  setActiveSession,
  setSessionRuntime,
  updateSessionWork,
  updateSessionWorks,
} from "./runtime.js";
import { registerTodoTool } from "./tool.js";
import { shouldCheckTodoInput } from "./input-sync.js";
import { formatWorkQueueForAgent } from "./work-queue.js";
import { registerTodoWorkTool } from "./work-tool.js";
import { findDidaTodoConflicts } from "./compatibility.js";
import { startTodoPoller } from "./poller.js";

async function detectTmuxTarget(pi: ExtensionAPI, pane: string | undefined): Promise<string | undefined> {
  if (!pane) return undefined;
  const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}"], {
    timeout: 3000,
  });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export default async function didaTodo(pi: ExtensionAPI): Promise<void> {
  const conflicts = findDidaTodoConflicts(
    pi.getAllTools().map((tool) => ({ name: tool.name, source: tool.sourceInfo.source || tool.sourceInfo.path })),
    pi.getCommands().map((command) => ({ name: command.name, source: command.sourceInfo.source || command.sourceInfo.path })),
  );
  if (conflicts.length) {
    throw new Error(`dida-todo 与已加载扩展冲突：${conflicts.join("；")}。请禁用 @juicesharp/rpiv-todo 或其他注册同名接口的扩展。`);
  }
  const config = await loadConfig();
  const gateway = new DidaCliGateway(pi, resolveDidaCommand(config));
  const repository = new DidaTodoRepository(gateway);
  let activeUI = false;
  const stopPollers = new Map<string, () => void>();

  const overlay = new TodoOverlay(
    getActiveTasks,
    () => getActiveRuntime()?.work?.remote.title,
    () => config.maxWidgetLines ?? DEFAULT_MAX_WIDGET_LINES,
    config.collapseKey ?? DEFAULT_COLLAPSE_KEY,
  );
  const refreshOverlay = () => overlay.update();

  registerTodoTool(pi, repository, refreshOverlay);
  registerTodoWorkTool(pi, repository, refreshOverlay);
  registerCommands(pi, repository, refreshOverlay);

  const collapseKey = (config.collapseKey ?? DEFAULT_COLLAPSE_KEY).trim().toLowerCase();
  if (collapseKey !== "off") {
    pi.registerShortcut(collapseKey as never, {
      description: "折叠或展开滴答 Todo 面板",
      handler: () => {
        if (overlay.isRegistered()) overlay.toggle();
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const tmuxTarget = await detectTmuxTarget(pi, process.env.TMUX_PANE);
    const binding = resolveBinding(config, ctx.cwd, tmuxTarget);
    if (!binding) return;
    const scope = {
      binding,
      bindingKey: bindingKeyFor(ctx.cwd, tmuxTarget),
      cwd: ctx.cwd,
      ...(tmuxTarget ? { tmuxTarget } : {}),
      sessionId,
    };
    const sync = await repository.syncOpenWorks(scope, { adoptUnmanaged: true }, ctx.signal);
    const works = sync.works;
    const work = works.length === 1 && config.autoResumeSingle !== false ? works[0] : undefined;
    setSessionRuntime(sessionId, { scope, works, lastSyncAt: new Date().toISOString(), ...(work ? { work } : {}) });
    if (ctx.hasUI && !activeUI) {
      activeUI = true;
      setActiveSession(sessionId, ctx.ui);
      overlay.setUI(ctx.ui);
      overlay.update(true);
      if (!work && works.length > 1) {
        ctx.ui.notify(`当前项目有 ${works.length} 个未完成工作任务；可直接说“检查 Todo”让 LLM 按优先级执行`, "warning");
      }
    }
    if (config.pollIntervalMinutes !== undefined) {
      stopPollers.get(sessionId)?.();
      stopPollers.set(
        sessionId,
        startTodoPoller(pi, ctx, repository, config.pollIntervalMinutes, () => overlay.update(true)),
      );
    }
  });

  pi.on("input", async (event) => {
    if (!shouldCheckTodoInput(event.text)) return { action: "continue" };
    const runtime = getActiveRuntime();
    if (!runtime) return { action: "continue" };
    const sync = await repository.syncOpenWorks(runtime.scope, { adoptUnmanaged: true });
    updateSessionWorks(runtime.scope.sessionId, sync.works, runtime.work?.remote.id);
    const refreshed = getActiveRuntime();
    if (!refreshed?.work && sync.works.length > 0) updateSessionWork(runtime.scope.sessionId, sync.works[0]);
    overlay.update(true);
    const injected = [formatWorkQueueForAgent(sync.works, sync.adoptedWorkIds.length, sync.acceptances), "", event.text].join("\n");
    return { action: "transform", text: injected };
  });

  pi.on("agent_start", () => overlay.hideCompletedFromPreviousTurn());

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const wasActive = getSessionRuntime(sessionId) === getActiveRuntime();
    stopPollers.get(sessionId)?.();
    stopPollers.delete(sessionId);
    removeSessionRuntime(sessionId);
    if (wasActive) {
      overlay.dispose();
      clearActiveSession(sessionId);
      activeUI = false;
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtime = getSessionRuntime(sessionId);
    if (!runtime?.work) return;
    const work = await repository.getWork(runtime.scope, runtime.work.remote.id, ctx.signal);
    updateSessionWork(sessionId, work);
    if (runtime === getActiveRuntime()) overlay.update(true);
  });
}
