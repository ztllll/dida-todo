import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_MAX_WIDGET_LINES,
  loadConfig,
  resolveBinding,
  resolveDidaCommand,
  resolvePollIntervalMinutes,
} from "./config.js";
import { registerCommands } from "./commands.js";
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
  setAllowedTrackingReasons,
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
import { ensureProjectBinding, isDidaAuthenticationError } from "./provisioning.js";
import { registerDidaSetupTool } from "./setup-tool.js";
import { finalizeWorkAtSettlement } from "./settled-finalization.js";
import { classifyTodoTrackingReasons } from "./tracking-policy.js";
import { detectProvisioningNamespace } from "./tmuxbot-route.js";

async function detectTmuxTarget(pi: ExtensionAPI, pane: string | undefined): Promise<string | undefined> {
  if (!pane) return undefined;
  const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}"], {
    timeout: 3000,
  });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export default async function didaTodo(pi: ExtensionAPI): Promise<void> {
  const config = await loadConfig();
  const gateway = new DidaCliGateway(pi, resolveDidaCommand(config));
  const repository = new DidaTodoRepository(gateway);
  const acceptanceResultUpdater = new AcceptanceResultUpdater(gateway);
  let activeUI = false;
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
    const executableWorks = works.filter(isExecutableWork);
    const work = executableWorks.length === 1 && config.autoResumeSingle !== false ? executableWorks[0] : undefined;
    setSessionRuntime(sessionId, { scope, works, lastSyncAt: new Date().toISOString(), ...(work ? { work } : {}) });
    if (ctx.hasUI && !activeUI) {
      activeUI = true;
      setActiveSession(sessionId, ctx.ui);
      overlay.setUI(ctx.ui);
    }
    if (ctx.hasUI) overlay.update(true);
    stopPollers.get(sessionId)?.();
    stopPollers.set(sessionId, startTodoPoller(pi, ctx, repository, resolvePollIntervalMinutes(config), () => overlay.update(true)));
    return sync;
  };

  registerDidaSetupTool(
    pi,
    gateway,
    config,
    (sessionId) => setupContexts.get(sessionId),
    async (ctx, binding) => { await activateBinding(ctx, binding); },
  );

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const tmuxTarget = await detectTmuxTarget(pi, process.env.TMUX_PANE);
    setupContexts.set(sessionId, { cwd: ctx.cwd, ...(tmuxTarget ? { tmuxTarget } : {}) });
    let binding = resolveBinding(config, ctx.cwd, tmuxTarget);
    if (!binding && config.autoProvisionProject !== false) {
      try {
        const namespace = await detectProvisioningNamespace(pi, tmuxTarget);
        const provisioned = await ensureProjectBinding({ gateway, cwd: ctx.cwd, tmuxTarget, namespace, signal: ctx.signal });
        binding = provisioned.binding;
        config.bindings = provisioned.config.bindings;
        if (ctx.hasUI) {
          ctx.ui.notify(
            provisioned.createdProject
              ? `已自动创建并绑定滴答清单：${provisioned.project.name}`
              : `已自动绑定现有滴答清单：${provisioned.project.name}`,
            "info",
          );
        }
      } catch (error) {
        if (ctx.hasUI && isDidaAuthenticationError(error)) {
          ctx.ui.notify("dida-todo 已安装，但内置 Dida CLI 尚未登录。直接告诉 LLM“登录滴答”即可打开浏览器授权；也可在 dida-todo 安装目录运行 ./node_modules/.bin/dida auth login。登录后会自动创建并绑定当前项目清单。", "warning");
          return;
        }
        throw error;
      }
    }
    if (!binding) return;
    const sync = await activateBinding(ctx, binding);
    const runtime = getSessionRuntime(sessionId);
    if (ctx.hasUI && runtime) {
      if (runtime.works.length === 0) {
        ctx.ui.notify("滴答 Todo 已就绪：当前清单为空，可直接口述任务；首个 Todo 会自动建立顶层工作。", "info");
      } else if (!runtime.work && runtime.works.every((candidate) => !isExecutableWork(candidate))) {
        ctx.ui.notify(`滴答 Todo 已就绪：已同步 ${runtime.works.length} 个顶层任务；当前没有满足优先级和时间条件的可执行工作。`, "info");
      }
    }
    const executableWorks = runtime?.works.filter(isExecutableWork) ?? [];
    if (ctx.hasUI && sync.finalizationFailures.length) {
      ctx.ui.notify(
        [
          "以下工作已完成全部 Checklist，但自动创建验收 Todo 失败；源任务仍保持未完成：",
          ...sync.finalizationFailures.map((failure) => `- ${failure.title}：${failure.error}`),
        ].join("\n"),
        "error",
      );
    }
    if (ctx.hasUI && !runtime?.work && executableWorks.length > 1) {
      ctx.ui.notify(`当前项目有 ${executableWorks.length} 个已设置优先级的未完成工作任务；空闲 Poller 会自动领取，也可完整输入“检查todo”立即执行`, "info");
    }
  });

  pi.on("input", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    setAllowedTrackingReasons(sessionId, classifyTodoTrackingReasons(event.text));
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
