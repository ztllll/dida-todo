import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_MAX_WIDGET_LINES,
  loadConfig,
  resolveBinding,
  resolveDidaCommand,
  resolvePollIntervalMinutes,
} from "./config.js";
import { registerCommands, registerDidaBindCommand } from "./commands.js";
import { DidaCliGateway } from "./gateway.js";
import { TodoOverlay } from "./overlay.js";
import { AcceptanceResultUpdater, extractFinalAssistantResponse } from "./acceptance-result.js";
import { DidaTodoRepository, type SyncOpenWorksResult } from "./repository.js";
import {
  clearActiveSession,
  clearAllowedTrackingReasons,
  clearQueueCheckPermission,
  getActiveRuntime,
  getActiveTasks,
  clearPendingAcceptanceResults,
  getSessionRuntime,
  hasQueueCheckPermission,
  pendingAcceptanceResults,
  pendingWorkFinalizations,
  queueAcceptanceResultSource,
  removeSessionRuntime,
  resolveWorkFinalization,
  runtimeForInput,
  setActiveSession,
  setQueueCheckPermission,
  setLatestFinalResponse,
  setSessionRuntime,
  updateSessionWork,
  updateSessionWorks,
} from "./runtime.js";
import { registerTodoTool } from "./tool.js";
import { shouldAcceptAutomaticPollInput, shouldCheckTodoInput } from "./input-sync.js";
import { formatWorkQueueForAgent, isExecutableWork } from "./work-queue.js";
import { registerTodoWorkTool } from "./work-tool.js";
import { startTodoPoller } from "./poller.js";
import { isDidaAuthenticationError } from "./provisioning.js";
import { registerDidaSetupTool } from "./setup-tool.js";
import { finalizeWorkAtSettlement } from "./settled-finalization.js";
import { replayTodoWork } from "./replay.js";
import { JsonWorkStateStore } from "./state-store.js";

async function detectTmuxTarget(pi: ExtensionAPI, pane: string | undefined): Promise<string | undefined> {
  if (!pane) return undefined;
  const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}"], {
    timeout: 3000,
  });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export function initializePassiveSession(config: import("./domain.js").DidaTodoConfig, cwd: string, sessionId: string): boolean {
  const binding = resolveBinding(config, cwd);
  if (!binding) return false;
  const scope = {
    binding,
    bindingKey: binding.key,
    cwd,
    sessionId,
  };
  setSessionRuntime(sessionId, { scope, works: [], lastSyncAt: new Date().toISOString() });
  return true;
}

export default async function didaTodo(pi: ExtensionAPI): Promise<void> {
  const config = await loadConfig();
  const gateway = new DidaCliGateway(pi, resolveDidaCommand(config));
  const stateStore = new JsonWorkStateStore();
  const repository = new DidaTodoRepository(gateway, stateStore);
  const acceptanceResultUpdater = new AcceptanceResultUpdater(gateway, stateStore);
  const stopPollers = new Map<string, () => void>();
  const setupContexts = new Map<string, { cwd: string; tmuxTarget?: string }>();

  const overlay = new TodoOverlay(
    getActiveTasks,
    () => getActiveRuntime()?.work?.remote.id,
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

  const activateBinding = async (
    ctx: ExtensionContext,
    binding: import("./domain.js").ProjectBinding,
  ): Promise<SyncOpenWorksResult> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const current = setupContexts.get(sessionId) ?? { cwd: ctx.cwd };
    const scope = {
      binding,
      bindingKey: binding.key,
      cwd: current.cwd,
      ...(current.tmuxTarget ? { tmuxTarget: current.tmuxTarget } : {}),
      sessionId,
    };
    let sync: SyncOpenWorksResult;
    try {
      sync = await repository.syncOpenWorks(scope, { adoptUnmanaged: true }, ctx.signal);
    } catch (error) {
      if (isDidaAuthenticationError(error)) {
        if (ctx.hasUI) ctx.ui.notify("滴答登录已过期。直接告诉 LLM“登录滴答”以重新授权；无需 /reload。", "warning");
        throw new Error("滴答登录已过期；请调用 dida_todo_setup login 重新授权后重试。");
      }
      throw error;
    }
    const works = sync.works;
    const previous = getSessionRuntime(sessionId);
    const previousWork = previous?.work;
    const kept = previousWork ? works.find((work) => work.remote.id === previousWork.remote.id) : undefined;
    const executableWorks = works.filter(isExecutableWork);
    const work = kept
      ?? (executableWorks.length === 1 && config.autoResumeSingle !== false ? executableWorks[0] : undefined);
    setSessionRuntime(sessionId, {
      scope,
      works,
      lastSyncAt: new Date().toISOString(),
      ...(work ? { work } : {}),
      ...(previous?.pendingFinalizationWorkIds ? { pendingFinalizationWorkIds: previous.pendingFinalizationWorkIds } : {}),
      ...(previous?.pendingAcceptanceResultSources ? { pendingAcceptanceResultSources: previous.pendingAcceptanceResultSources } : {}),
      ...(previous?.latestFinalResponse ? { latestFinalResponse: previous.latestFinalResponse } : {}),
    });
    return sync;
  };

  const bindUiAndPoller = (ctx: ExtensionContext, sessionId: string): void => {
    if (!ctx.hasUI) return;
    overlay.update(true);
    stopPollers.get(sessionId)?.();
    stopPollers.set(sessionId, startTodoPoller(pi, ctx, repository, resolvePollIntervalMinutes(config), () => overlay.update(true)));
  };

  registerDidaSetupTool(
    pi,
    gateway,
    config,
    (sessionId) => setupContexts.get(sessionId),
    async (ctx, binding) => {
      await activateBinding(ctx, binding);
      bindUiAndPoller(ctx, ctx.sessionManager.getSessionId());
    },
  );
  registerDidaBindCommand(
    pi,
    gateway,
    config,
    (sessionId) => setupContexts.get(sessionId),
    async (ctx, binding) => {
      await activateBinding(ctx, binding);
      bindUiAndPoller(ctx, ctx.sessionManager.getSessionId());
    },
  );

  pi.on("session_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Web/RPC/Print starts must never require Dida, tmux, or interactive input.
    if (!ctx.hasUI || ctx.mode !== "tui") {
      setupContexts.set(sessionId, { cwd: ctx.cwd });
      initializePassiveSession(config, ctx.cwd, sessionId);
      return;
    }
    const tmuxTarget = await detectTmuxTarget(pi, process.env.TMUX_PANE).catch(() => undefined);
    setupContexts.set(sessionId, { cwd: ctx.cwd, ...(tmuxTarget ? { tmuxTarget } : {}) });
    const binding = resolveBinding(config, ctx.cwd, tmuxTarget);
    // 挂载 Overlay 不依赖 Dida 同步成败：先挂面板，任务内容随后重放/同步。
    setActiveSession(sessionId, ctx.ui);
    overlay.setUI(ctx.ui);
    if (!binding) {
      ctx.ui.notify("当前目录未绑定滴答分组；Pi 已以被动模式启动。需要 Todo 时执行 /dida-bind。", "warning");
      return;
    }
    // Dida sync is background work: Pi session startup must not wait for it.
    // 先建临时 Runtime（从上一个会话重放最后快照，或空清单），工具与面板立即可用。
    const scope: import("./domain.js").TodoScope = {
      binding,
      bindingKey: binding.key,
      cwd: ctx.cwd,
      ...(tmuxTarget ? { tmuxTarget } : {}),
      sessionId,
    };
    const replayed = event.previousSessionFile ? replayTodoWork(event.previousSessionFile, scope) : undefined;
    setSessionRuntime(sessionId, { scope, works: replayed ? [replayed] : [], ...(replayed ? { work: replayed } : {}) });
    void activateBinding(ctx, binding).then((sync) => {
      const runtime = getSessionRuntime(sessionId);
      if (runtime?.works.length === 0) {
        ctx.ui.notify("滴答 Todo 已就绪：当前清单为空，可直接口述任务；首个 Todo 会自动建立顶层工作。", "info");
      } else if (runtime && !runtime.work && runtime.works.every((candidate) => !isExecutableWork(candidate))) {
        ctx.ui.notify(`滴答 Todo 已就绪：已同步 ${runtime.works.length} 个顶层任务；当前没有满足优先级和时间条件的可执行工作。`, "info");
      }
      if (sync.finalizationFailures.length) {
        ctx.ui.notify(
          [
            "以下工作已完成全部 Checklist，但自动创建验收 Todo 失败；源任务仍保持未完成：",
            ...sync.finalizationFailures.map((failure) => `- ${failure.title}：${failure.error}`),
          ].join("\n"),
          "error",
        );
      }
      const executableWorks = runtime?.works.filter(isExecutableWork) ?? [];
      if (!runtime?.work && executableWorks.length > 1) {
        ctx.ui.notify(`当前项目有 ${executableWorks.length} 个已设置优先级的未完成工作任务；空闲 Poller 会自动领取，也可完整输入“检查todo”立即执行`, "info");
      }
      bindUiAndPoller(ctx, sessionId);
    }).catch((error) => {
      const message = isDidaAuthenticationError(error)
        ? "滴答未登录或登录已过期；Pi 已正常启动。需要 Todo 时执行 /dida-bind 重新授权。"
        : `滴答同步不可用；面板先显示本地状态，Poller 会自动重试同步。原因：${error instanceof Error ? error.message : String(error)}`;
      ctx.ui.notify(message, "warning");
      bindUiAndPoller(ctx, sessionId);
    });
  });

  pi.on("input", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const manualQueueCheck = shouldCheckTodoInput(event.text);
    const automaticQueueCheck = shouldAcceptAutomaticPollInput(
      event.text,
      event.source,
      getSessionRuntime(sessionId) !== undefined && hasQueueCheckPermission(sessionId),
    );
    const checkQueue = manualQueueCheck || automaticQueueCheck;
    setQueueCheckPermission(sessionId, checkQueue);
    if (!checkQueue || automaticQueueCheck) return { action: "continue" };
    const runtime = runtimeForInput(sessionId);
    if (!runtime) return { action: "continue" };
    let sync: SyncOpenWorksResult;
    try {
      sync = await repository.syncOpenWorks(runtime.scope, {
        adoptUnmanaged: true,
        deferFinalizationWorkIds: pendingWorkFinalizations(runtime.scope.sessionId),
      });
    } catch (error) {
      if (isDidaAuthenticationError(error)) {
        throw new Error("滴答登录已过期；请调用 dida_todo_setup login 重新授权后重试。");
      }
      throw error;
    }
    updateSessionWorks(runtime.scope.sessionId, sync.works, runtime.work?.remote.id);
    const refreshed = getActiveRuntime();
    const firstExecutable = sync.works.find(isExecutableWork);
    if (!refreshed?.work && firstExecutable) updateSessionWork(runtime.scope.sessionId, firstExecutable);
    overlay.update(true);
    const injected = [
      formatWorkQueueForAgent(sync.works, sync.adoptedWorkIds.length, sync.acceptances, sync.finalizationFailures),
      "",
      event.text,
    ].join("\n");
    return { action: "transform", text: injected };
  });

  pi.on("agent_end", (event, ctx) => {
    const finalResponse = extractFinalAssistantResponse(event.messages as never[]);
    if (finalResponse) setLatestFinalResponse(ctx.sessionManager.getSessionId(), finalResponse);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtime = getSessionRuntime(sessionId);
    if (!runtime) return;
    for (const workId of pendingWorkFinalizations(sessionId)) {
      try {
        const result = await finalizeWorkAtSettlement(repository, runtime.scope, workId, ctx.signal);
        if (result.state === "not-ready") {
          resolveWorkFinalization(sessionId, workId);
          continue;
        }
        updateSessionWork(sessionId, result.work);
        queueAcceptanceResultSource(sessionId, result.work.remote);
        resolveWorkFinalization(sessionId, workId);
        if (runtime === getActiveRuntime()) overlay.update(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`待验收收口失败，源任务仍保持未完成：${message}`, "error");
        if (process.env.PI_DIDA_TODO_DEBUG === "1") console.error("dida-todo settled finalization failed", error);
      }
    }
    const pending = pendingAcceptanceResults(sessionId);
    if (!pending.sources.length || !pending.finalResponse) {
      clearAllowedTrackingReasons(sessionId);
      clearQueueCheckPermission(sessionId);
      return;
    }
    try {
      const deriveTitle = pending.sources.length === 1;
      for (const source of pending.sources) {
        await acceptanceResultUpdater.update(runtime.scope, source, pending.finalResponse, ctx.signal, { deriveTitle });
      }
      clearPendingAcceptanceResults(sessionId);
    } catch (error) {
      if (process.env.PI_DIDA_TODO_DEBUG === "1") console.error("dida-todo acceptance result update failed", error);
    } finally {
      clearAllowedTrackingReasons(sessionId);
      clearQueueCheckPermission(sessionId);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const wasActive = getSessionRuntime(sessionId) === getActiveRuntime();
    stopPollers.get(sessionId)?.();
    stopPollers.delete(sessionId);
    setupContexts.delete(sessionId);
    removeSessionRuntime(sessionId);
    if (wasActive) {
      overlay.dispose();
      clearActiveSession(sessionId);
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
