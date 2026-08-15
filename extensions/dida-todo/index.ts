import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_MAX_WIDGET_LINES,
  loadConfig,
  resolveBinding,
  resolveDidaCommand,
  resolveConfigPath,
  resolvePollIntervalMinutes,
} from "./config.js";
import type { ProjectBinding } from "./domain.js";
import { registerCommands } from "./commands.js";
import { DidaCliGateway } from "./gateway.js";
import { DidaTodoOverlay } from "./overlay.js";
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
import { registerDidaTodoTool } from "./tool.js";
import { shouldAcceptAutomaticPollInput, shouldCheckTodoInput } from "./input-sync.js";
import { formatWorkQueueForAgent, isExecutableWork } from "./work-queue.js";
import { isWorkReadyForFinalization } from "./work-type.js";
import { registerDidaTodoWorkTool } from "./work-tool.js";
import { startTodoPoller } from "./poller.js";
import { deriveBindingIdentity, ensureExistingBindingAliases, ensureProjectBinding, isDidaAuthenticationError } from "./provisioning.js";
import { registerDidaSetupTool } from "./setup-tool.js";
import { classifyTodoTrackingReasons } from "./tracking-policy.js";
import { detectProvisioningNamespace } from "./tmuxbot-route.js";
import type { ProvisioningNamespace } from "./provisioning-identity.js";
import { JsonWorkStateStore } from "./state-store.js";

const DIDA_TOOL_NAMES = ["dida_todo", "dida_todo_work", "dida_todo_setup"] as const;
const DIDA_ROUTE_CONTRACT = [
  "Dida routing contract:",
  "- OMP native todo is the current-session execution ledger. Do not replace, wrap, proxy, or automatically modify it.",
  "- dida_todo is the durable cross-session Dida source of truth. When executing Dida work, explicitly keep OMP todo and dida_todo aligned.",
  "- Only exact `检查todo` input or a trusted dida-todo Poller follow-up authorizes scanning and switching the Dida queue.",
  "- Use Dida only for durable user work; ordinary chat, Q&A, one-off research, read-only inspection, translation, rewriting, and summarization do not create Dida work.",
].join("\n");

function extensionIoSignal(): AbortSignal {
  return AbortSignal.timeout(25_000);
}

async function detectTmuxTarget(pi: ExtensionAPI, pane: string | undefined): Promise<string | undefined> {
  if (!pane) return undefined;
  const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}"], {
    timeout: 3000,
  });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export default async function didaTodo(pi: ExtensionAPI): Promise<void> {
  const configPath = resolveConfigPath();
  const config = await loadConfig();
  const gateway = new DidaCliGateway(pi, resolveDidaCommand(config));
  const stateStore = new JsonWorkStateStore();
  const repository = new DidaTodoRepository(gateway, stateStore);
  const acceptanceResultUpdater = new AcceptanceResultUpdater(gateway, stateStore);
  const stopPollers = new Map<string, () => void>();
  const setupContexts = new Map<string, { cwd: string; tmuxTarget?: string; namespace?: ProvisioningNamespace }>();
  const interactiveSessions = new Set<string>();
  const overlay = new DidaTodoOverlay(
    getActiveTasks,
    () => config.maxWidgetLines ?? DEFAULT_MAX_WIDGET_LINES,
    config.collapseKey ?? DEFAULT_COLLAPSE_KEY,
  );
  const refreshOverlay = () => overlay.update();
  const isInteractiveSession = (sessionId: string) => interactiveSessions.has(sessionId);
  const disposeDidaSession = (sessionId: string) => {
    const wasActive = getActiveRuntime()?.scope.sessionId === sessionId;
    stopPollers.get(sessionId)?.();
    stopPollers.delete(sessionId);
    setupContexts.delete(sessionId);
    interactiveSessions.delete(sessionId);
    if (wasActive) {
      overlay.dispose();
      clearActiveSession(sessionId);
    }
    removeSessionRuntime(sessionId);
  };

  registerDidaTodoTool(pi, repository, refreshOverlay);
  registerDidaTodoWorkTool(pi, repository, refreshOverlay);
  registerCommands(pi, repository, refreshOverlay, isInteractiveSession);

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
    binding: ProjectBinding,
  ): Promise<SyncOpenWorksResult> => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!ctx.hasUI || !isInteractiveSession(sessionId)) {
      throw new Error("滴答仅支持已激活的 OMP Interactive/TUI 主会话。");
    }
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
      sync = await repository.syncOpenWorks(scope, { adoptUnmanaged: true }, extensionIoSignal());
    } catch (error) {
      if (isDidaAuthenticationError(error)) {
        ctx.ui.notify("滴答登录已过期。直接告诉 LLM“登录滴答”以重新授权；无需 /reload。", "warning");
        throw new Error("滴答登录已过期；请调用 dida_todo_setup login 重新授权后重试。");
      }
      throw error;
    }
    const executableWorks = sync.works.filter(isExecutableWork);
    const work = executableWorks.length === 1 && config.autoResumeSingle !== false ? executableWorks[0] : undefined;
    setSessionRuntime(sessionId, { scope, works: sync.works, lastSyncAt: new Date().toISOString(), ...(work ? { work } : {}) });
    setActiveSession(sessionId, ctx.ui);
    overlay.setUI(ctx.ui);
    overlay.update(true);
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
    configPath,
    isInteractiveSession,
  );

  const initializeInteractiveSession = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const activeSessionId = getActiveRuntime()?.scope.sessionId;
    if (activeSessionId && activeSessionId !== sessionId) disposeDidaSession(activeSessionId);
    disposeDidaSession(sessionId);
    interactiveSessions.add(sessionId);
    await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...DIDA_TOOL_NAMES])]);
    const tmuxTarget = await detectTmuxTarget(pi, process.env.TMUX_PANE);
    const namespace = await detectProvisioningNamespace(pi, tmuxTarget);
    const identity = deriveBindingIdentity(ctx.cwd, tmuxTarget, namespace);
    setupContexts.set(sessionId, { cwd: ctx.cwd, ...(tmuxTarget ? { tmuxTarget } : {}), namespace });
    let binding = resolveBinding(config, ctx.cwd, tmuxTarget, identity.projectName);
    if (binding) {
      const persisted = await ensureExistingBindingAliases({ binding, cwd: ctx.cwd, tmuxTarget, namespace, configPath });
      binding = persisted.binding;
      config.bindings = persisted.config.bindings;
    } else if (config.autoProvisionProject !== false) {
      try {
        const provisioned = await ensureProjectBinding({ gateway, cwd: ctx.cwd, tmuxTarget, namespace, signal: extensionIoSignal() });
        binding = provisioned.binding;
        config.bindings = provisioned.config.bindings;
        ctx.ui.notify(
          provisioned.createdProject
            ? `已自动创建并绑定滴答清单：${provisioned.project.name}`
            : `已自动绑定现有滴答清单：${provisioned.project.name}`,
          "info",
        );
      } catch (error) {
        if (isDidaAuthenticationError(error)) {
          ctx.ui.notify("dida-todo 已安装，但内置 Dida CLI 尚未登录。直接告诉 LLM“登录滴答”即可打开浏览器授权；也可在 dida-todo 安装目录运行 ./node_modules/.bin/dida auth login。登录后会自动创建并绑定当前项目清单。", "warning");
          return;
        }
        throw error;
      }
    }
    if (!binding) return;
    const sync = await activateBinding(ctx, binding);
    const runtime = getSessionRuntime(sessionId);
    if (runtime?.works.length === 0) {
      ctx.ui.notify("滴答 Todo 已就绪：当前清单为空，可直接口述任务；首个 Todo 会自动建立顶层工作。", "info");
    } else if (!runtime?.work && runtime?.works.every((candidate) => !isExecutableWork(candidate))) {
      ctx.ui.notify(`滴答 Todo 已就绪：已同步 ${runtime.works.length} 个顶层任务；当前没有满足优先级和时间条件的可执行工作。`, "info");
    }
    const executableWorks = runtime?.works.filter(isExecutableWork) ?? [];
    if (sync.finalizationFailures.length) {
      ctx.ui.notify(
        [
          "以下工作已完成全部 Checklist，但自动创建验收 Todo 失败；源任务仍保持未完成：",
          ...sync.finalizationFailures.map((failure) => `- ${failure.title}：${failure.error}`),
        ].join("\n"),
        "error",
      );
    }
    if (!runtime?.work && executableWorks.length > 1) {
      ctx.ui.notify(`当前项目有 ${executableWorks.length} 个已设置优先级的未完成工作任务；空闲 Poller 会自动领取，也可完整输入“检查todo”立即执行`, "info");
    }
  };

  const refreshCurrentWork = async (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!ctx.hasUI || !isInteractiveSession(sessionId)) return;
    const runtime = getSessionRuntime(sessionId);
    if (!runtime?.work) return;
    const work = await repository.getWork(runtime.scope, runtime.work.remote.id, extensionIoSignal());
    updateSessionWork(sessionId, work);
    if (runtime === getActiveRuntime()) overlay.update(true);
  };

  pi.on("session_start", async (_event, ctx) => { await initializeInteractiveSession(ctx); });
  pi.on("session_switch", async (_event, ctx) => { await initializeInteractiveSession(ctx); });
  pi.on("session_branch", async (_event, ctx) => { await initializeInteractiveSession(ctx); });
  pi.on("before_agent_start", (event, ctx) => {
    if (!ctx.hasUI || !isInteractiveSession(ctx.sessionManager.getSessionId())) return undefined;
    return { systemPrompt: [...event.systemPrompt, DIDA_ROUTE_CONTRACT] };
  });

  pi.on("input", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!ctx.hasUI || !isInteractiveSession(sessionId)) return undefined;
    const manualQueueCheck = shouldCheckTodoInput(event.text);
    const automaticQueueCheck = shouldAcceptAutomaticPollInput(
      event.text,
      event.source,
      getSessionRuntime(sessionId) !== undefined && hasQueueCheckPermission(sessionId),
    );
    if (!automaticQueueCheck) setAllowedTrackingReasons(sessionId, classifyTodoTrackingReasons(event.text));
    const checkQueue = manualQueueCheck || automaticQueueCheck;
    setQueueCheckPermission(sessionId, checkQueue);
    if (!checkQueue || automaticQueueCheck) return undefined;
    const runtime = runtimeForInput(sessionId);
    if (!runtime) return undefined;
    let sync: SyncOpenWorksResult;
    try {
      sync = await repository.syncOpenWorks(runtime.scope, {
        adoptUnmanaged: true,
        deferFinalizationWorkIds: pendingWorkFinalizations(runtime.scope.sessionId),
      }, extensionIoSignal());
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
    return { text: injected };
  });

  pi.on("agent_end", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!ctx.hasUI || !isInteractiveSession(sessionId) || event.willContinue === true) return;
    const finalResponse = extractFinalAssistantResponse(event.messages as never[]);
    if (finalResponse) setLatestFinalResponse(sessionId, finalResponse);
    const runtime = getSessionRuntime(sessionId);
    const signal = extensionIoSignal();
    try {
      if (!runtime) return;
      for (const workId of pendingWorkFinalizations(sessionId)) {
        try {
          const work = await repository.getWork(runtime.scope, workId, signal);
          const visibleTasks = work.tasks.filter((task) => task.status !== "deleted");
          if (!visibleTasks.length || !visibleTasks.every((task) => task.status === "completed" || task.status === "skipped") || !isWorkReadyForFinalization(work)) {
            resolveWorkFinalization(sessionId, workId);
            continue;
          }
          await repository.finishWork(runtime.scope, workId, signal);
          const finalizedWork = { ...work, remote: { ...work.remote, status: 2 } };
          updateSessionWork(sessionId, finalizedWork);
          queueAcceptanceResultSource(sessionId, finalizedWork.remote);
          resolveWorkFinalization(sessionId, workId);
          if (runtime === getActiveRuntime()) overlay.update(true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`待验收收口失败，源任务仍保持未完成：${message}`, "error");
          pi.logger.error(`dida-todo agent-end finalization failed: ${message}`);
        }
      }
      const pending = pendingAcceptanceResults(sessionId);
      if (!pending.sources.length || !pending.finalResponse) return;
      const deriveTitle = pending.sources.length === 1;
      for (const source of pending.sources) {
        await acceptanceResultUpdater.update(runtime.scope, source, pending.finalResponse, signal, { deriveTitle });
      }
      clearPendingAcceptanceResults(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pi.logger.error(`dida-todo acceptance result update failed: ${message}`);
    } finally {
      clearAllowedTrackingReasons(sessionId);
      clearQueueCheckPermission(sessionId);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    disposeDidaSession(ctx.sessionManager.getSessionId());
  });

  pi.on("session_compact", async (_event, ctx) => { await refreshCurrentWork(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await refreshCurrentWork(ctx); });

}
