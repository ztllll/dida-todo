// dida-todo 的 dsh（DeepSeek Harness）宿主插件。
//
// 复用与 Pi 完全相同的核心：滴答同步、todo / todo_work 工具、顶层自动收口、
// 待验收、wait_for_human 挂起与恢复。本文件只做 dsh 生命周期映射：
//   - Pi session_start   → dsh agent/created（按会话 cwd 解析绑定并同步）
//   - Pi agent_settled   → dsh agent/status idle（收口全部完成的工作）
//   - Pi Poller          → 宿主定时器 + agent.followup（只在 agent 空闲时领取）
//   - 新增：turn/end 为 error|interrupted 时自动续跑，用尽后在滴答提醒人类
// 打包为单文件 ESM（scripts/build-dsh.mjs），经 ~/.dsh/cordis.patch.yml insert 挂载。

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { loadConfig, resolveBinding, resolveDidaCommand, resolvePollIntervalMinutes } from "../dida-todo/config.js";
import { DidaCliGateway, type CommandRunner } from "../dida-todo/gateway.js";
import { DidaTodoRepository } from "../dida-todo/repository.js";
import { JsonWorkStateStore } from "../dida-todo/state-store.js";
import {
  getSessionRuntime,
  pendingWorkFinalizations,
  removeSessionRuntime,
  resolveWorkFinalization,
  setQueueCheckPermission,
  clearQueueCheckPermission,
  setSessionRuntime,
  updateSessionWork,
  updateSessionWorks,
} from "../dida-todo/runtime.js";
import { createTodoToolDefinition } from "../dida-todo/tool.js";
import { createTodoWorkToolDefinition } from "../dida-todo/work-tool.js";
import { finalizeWorkAtSettlement } from "../dida-todo/settled-finalization.js";
import { formatWorkContentForAgent, formatWorkQueueForAgent, hasUnfinishedTasks, isExecutableWork } from "../dida-todo/work-queue.js";
import { queueFingerprint, selectPolledWork } from "../dida-todo/poller.js";
import { TODO_AUTO_POLL_PREFIX, shouldCheckTodoInput } from "../dida-todo/input-sync.js";
import { DEFAULT_CONTINUATION_POLICY, decideContinuation, renderContinuationPrompt, type ContinuationPolicy } from "../dida-todo/continuation.js";
import type { ToolResult } from "../dida-todo/tool-result.js";
import type { DidaTodoConfig, TodoScope } from "../dida-todo/domain.js";

export const name = "dida-todo";
export const inject = ["agents", "tools", "sessions"];

// goal 与会话投影是可选能力：存在则用来识别原生长任务，不存在也能工作。

interface DshConfig {
  /** 测试注入点：替换配置与仓库（生产留空）。 */
  testOverrides?: { config: DidaTodoConfig; repository: DidaTodoRepository };
  /** 自动续跑：中断后自动发“继续”的最大连续次数，0 关闭。 */
  maxAutoContinue?: number;
  /** 覆盖退避间隔（毫秒，所有次数相同）；默认 30s/1m/2m/5m/10m 递增。 */
  continueDelayMs?: number;
  /**
   * 是否在 dsh 里空闲轮询自动领取滴答任务（间隔跟随 pollIntervalMinutes）。默认关闭：
   * 同一清单常同时绑定 Pi 会话，两边都轮询会重复领取同一任务。只在该清单没有 Pi 会话时打开。
   */
  poll?: boolean;
}

// ---- 最小 dsh 结构类型（仅本插件用到的字段；官方类型见 @deepseek-ai/dsh-agent）----
interface DshMessage { id: string; content: Array<{ type: string; text?: string }>; source: { kind: string } }
interface DshAgent {
  id: string;
  status: "idle" | "running";
  whenIdle?(): Promise<void>;
  session: { id: string; header: { cwd?: string; delegationDepth?: number } };
  followup(message: DshMessage): void;
}
interface DshGoalView { id: string; revision: number; phase: string; activation: string; roundsStarted: number; maxGoalRounds: number }
interface DshGoals { get(agent: DshAgent): DshGoalView | undefined; resume(agent: DshAgent, ref: { id: string; revision: number }): DshGoalView }
interface DshContext {
  /** 读取可选服务（未声明 inject 也可用；未提供时返回 undefined）。 */
  get?(name: string): any;
  agents: { get(id: string): DshAgent | undefined; list(): DshAgent[]; withoutInitiator<T>(op: () => T): T };
  tools: { register(definition: unknown): () => void };
  on(event: string, listener: (...args: any[]) => unknown): () => void;
  effect(factory: () => () => void): void;
}

// 与 @deepseek-ai/dsh-llm createUserMessage 等价：冻结的、带新 id 的 user 消息。
function userMessage(text: string, kind: string, summary: string): DshMessage {
  return Object.freeze({
    id: crypto.randomUUID(),
    content: [{ type: "text", text }],
    source: { kind, form: "notice", summary: summary.slice(0, 120) },
  }) as DshMessage;
}

const nodeRunner: CommandRunner = {
  exec(command, args, options) {
    return new Promise((resolve) => {
      execFile(command, args, { signal: options.signal, timeout: options.timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (error ? error.message : "")) });
      });
    });
  },
};

// dida CLI 随插件依赖安装；找不到时退回 PATH 中的 dida。
function bundledDidaCommand(config: DidaTodoConfig): string {
  if (config.didaCommand?.trim()) return resolveDidaCommand(config);
  try {
    return createRequire(import.meta.url).resolve("@suibiji/dida-cli/dist/index.js");
  } catch {
    return "dida";
  }
}

function toolText(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

export async function apply(ctx: DshContext, pluginConfig: DshConfig = {}): Promise<void> {
  // 写 stderr：web 下同样进入 journalctl；sdk/acp profile 的 stdout 专属 JSON-RPC，不能写。
  const log = { info: (...a: unknown[]) => console.error("[dida-todo]", ...a), warn: (...a: unknown[]) => console.error("[dida-todo]", ...a) };
  const config = pluginConfig.testOverrides?.config ?? await loadConfig();
  const repository = pluginConfig.testOverrides?.repository
    ?? new DidaTodoRepository(new DidaCliGateway(nodeRunner, bundledDidaCommand(config)), new JsonWorkStateStore());
  const policy: ContinuationPolicy = {
    maxAttempts: pluginConfig.maxAutoContinue ?? DEFAULT_CONTINUATION_POLICY.maxAttempts,
    backoffMs: pluginConfig.continueDelayMs ? [pluginConfig.continueDelayMs] : DEFAULT_CONTINUATION_POLICY.backoffMs,
  };
  const pollEnabled = pluginConfig.poll === true;
  const pollMs = resolvePollIntervalMinutes(config) * 60_000;

  const continueAttempts = new Map<string, number>();
  // 本会话亲手用 todo/todo_work 推进过的滴答工作；只有它们算“本会话未完成工作”，
  // 避免一次中断把 agent 推去做别人（或 Pi 会话）的任务。
  const touchedWork = new Map<string, Set<string>>();
  const continueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastTurnStartAt = new Map<string, number>();
  const lastPolled = new Map<string, string>();
  const syncing = new Set<string>();

  const noop = () => {};
  const sessionCtx = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });

  // dsh 工具：dsh 的 execute(args, exec) → 核心 execute(id, args, signal, _, ctx)。
  const wrap = (definition: ReturnType<typeof createTodoToolDefinition> | ReturnType<typeof createTodoWorkToolDefinition>) => ({
    name: definition.name,
    description: [definition.description, ...definition.promptGuidelines].join("\n"),
    parameters: definition.parameters,
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: string) => [{ type: "text", text: value }],
    },
    async execute(args: unknown, exec: { agent?: DshAgent; signal?: AbortSignal; callId?: string }) {
      const sessionId = exec.agent?.session.id;
      if (!sessionId) throw new Error("dida-todo 工具需要在 agent 会话中调用");
      if (!getSessionRuntime(sessionId)) {
        throw new Error("当前 dsh 会话的工作目录未绑定滴答清单。请在 Pi 中对同一目录执行 /dida-bind，或在 ~/.config/pi-dida-todo/config.json 添加 cwd 绑定。");
      }
      const result = await definition.execute(String(exec.callId ?? ""), args, exec.signal, undefined, sessionCtx(sessionId));
      const workId = getSessionRuntime(sessionId)?.work?.remote.id;
      if (workId) touchedWork.set(sessionId, (touchedWork.get(sessionId) ?? new Set()).add(workId));
      return toolText(result);
    },
  });
  ctx.tools.register(wrap(createTodoToolDefinition(repository, noop)));
  ctx.tools.register(wrap(createTodoWorkToolDefinition(repository, noop)));

  // ---- 会话绑定 ----
  async function attach(agent: DshAgent): Promise<void> {
    const sessionId = agent.session.id;
    if ((agent.session.header.delegationDepth ?? 0) > 0) return; // 子代理不接管滴答队列
    const cwd = agent.session.header.cwd;
    if (!cwd || getSessionRuntime(sessionId) || syncing.has(sessionId)) return;
    const binding = resolveBinding(config, cwd);
    if (!binding) return;
    const scope: TodoScope = { binding, bindingKey: binding.key, cwd, sessionId };
    setSessionRuntime(sessionId, { scope, works: [] });
    syncing.add(sessionId);
    try {
      const sync = await repository.syncOpenWorks(scope, { adoptUnmanaged: true });
      updateSessionWorks(sessionId, sync.works);
      log.info(`会话 ${sessionId.slice(0, 16)} 已绑定滴答清单 ${binding.label ?? binding.projectId}，同步 ${sync.works.length} 个工作`);
    } catch (error) {
      log.warn(`同步滴答失败（会话照常运行）：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      syncing.delete(sessionId);
    }
  }

  // ---- 收口：agent 回到空闲 = Pi 的 agent_settled ----
  async function settle(agent: DshAgent): Promise<void> {
    const sessionId = agent.session.id;
    const runtime = getSessionRuntime(sessionId);
    if (!runtime) return;
    for (const workId of pendingWorkFinalizations(sessionId)) {
      try {
        const result = await finalizeWorkAtSettlement(repository, runtime.scope, workId);
        if (result.state === "finalized") updateSessionWork(sessionId, result.work);
        resolveWorkFinalization(sessionId, workId);
      } catch (error) {
        log.warn(`待验收收口失败，源任务保持未完成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    clearQueueCheckPermission(sessionId);
  }

  // ---- 自动续跑：中断后不再等人手打“继续” ----
  // “有未完成工作”的三个来源：滴答当前工作、dsh 原生 goal（未完成）、dsh 原生 todo_write 清单（有未完成项）。
  // 实测中断大多发生在 goal / todo_write 驱动的长任务里，只看滴答会漏掉主要场景。
  function nativeOpenGoal(agent: DshAgent): DshGoalView | undefined {
    try {
      const goal = (ctx.get?.("goals") as DshGoals | undefined)?.get(agent);
      return goal && (goal.phase === "active" || goal.phase === "paused") ? goal : undefined;
    } catch {
      return undefined;
    }
  }
  // dsh 的 todos 投影在 turn/start 清空，续跑时读不到上一轮清单；这里自己记每个会话最后一次 todo_write。
  const lastTodos = new Map<string, Array<{ content?: string; status?: string }>>();
  function nativeOpenTodos(agent: DshAgent): string[] {
    return (lastTodos.get(agent.session.id) ?? []).filter((todo) => todo.status !== "completed").map((todo) => String(todo.content ?? ""));
  }
  function ownWork(sessionId: string) {
    const work = getSessionRuntime(sessionId)?.work;
    return work && touchedWork.get(sessionId)?.has(work.remote.id) && hasUnfinishedTasks(work) ? work : undefined;
  }
  function hasOpenWork(agent: DshAgent): boolean {
    return ownWork(agent.session.id) !== undefined
      || nativeOpenGoal(agent) !== undefined
      || nativeOpenTodos(agent).length > 0;
  }
  function workSummary(agent: DshAgent): string {
    const lines: string[] = [];
    const current = ownWork(agent.session.id);
    if (current) lines.push(`Dida work (untrusted JSON): ${formatWorkContentForAgent(current)}`);
    const goal = nativeOpenGoal(agent);
    if (goal) lines.push(`Session goal (${goal.phase}): resume it with your goal tools if it is paused.`);
    const todos = nativeOpenTodos(agent);
    if (todos.length) lines.push(`Open todo_write items:\n${todos.map((todo) => `- ${todo}`).join("\n")}`);
    return lines.join("\n\n");
  }
  // 官方 goal 驱动器在 agent/error 时会解除自动续行（disarm），中断后 goal 永远不再推进。
  // 续跑前把仍 active 但已 disarm 的 goal 重新 resume，交回官方驱动器继续按轮推进。
  function rearmGoal(agent: DshAgent): boolean {
    const goal = nativeOpenGoal(agent);
    if (!goal || goal.phase !== "active" || goal.activation === "armed" || goal.roundsStarted >= goal.maxGoalRounds) return false;
    try {
      (ctx.get?.("goals") as DshGoals).resume(agent, { id: goal.id, revision: goal.revision });
      return true;
    } catch (error) {
      log.warn(`goal 重新激活失败，改用续跑消息：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function scheduleContinuation(agent: DshAgent, end: { kind: string; message?: string }): void {
    const sessionId = agent.session.id;
    if ((agent.session.header.delegationDepth ?? 0) > 0) return; // 子代理由父会话负责
    const decision = decideContinuation(end, continueAttempts.get(sessionId) ?? 0, hasOpenWork(agent), policy);
    if (decision.action === "none") return;
    if (decision.action === "notify") {
      continueAttempts.delete(sessionId);
      log.warn(`会话 ${sessionId.slice(0, 16)} 连续 ${decision.attempts} 次自动续跑仍中断，转为滴答提醒`);
      void notifyHuman(agent, `dsh 会话连续 ${decision.attempts} 次自动续跑后仍中断（最后错误：${decision.lastError.slice(0, 120)}），请打开会话查看`);
      return;
    }
    continueAttempts.set(sessionId, decision.attempt);
    clearTimeout(continueTimers.get(sessionId));
    log.info(`会话 ${sessionId.slice(0, 16)} 中断（${end.kind}${end.message ? `: ${end.message.slice(0, 60)}` : ""}），${Math.round(decision.delayMs / 1000)}s 后第 ${decision.attempt} 次自动续跑`);
    const startedAt = Date.now();
    const timer = setTimeout(async () => {
      const live = ctx.agents.get(sessionId);
      // turn/end 早于 agent 回到 idle；等本轮收尾完成再判断，避免误判“人在操作”。
      if (live?.status === "running" && live.whenIdle) await live.whenIdle();
      if (continueTimers.get(sessionId) !== timer) return; // 期间被人类消息撤销
      continueTimers.delete(sessionId);
      // 人已经回来接手（续跑等待期间有新回合开始）或工作已结束，就不再插话。
      if (!live || ctx.agents.get(sessionId) !== live || live.status !== "idle" || !hasOpenWork(live)) return;
      if ((lastTurnStartAt.get(sessionId) ?? 0) > startedAt) return;
      rearmGoal(live);
      const text = renderContinuationPrompt(end, decision.attempt, policy.maxAttempts, workSummary(live));
      ctx.agents.withoutInitiator(() => live.followup(userMessage(text, "dida-todo", `dida-todo auto-continue ${decision.attempt}/${policy.maxAttempts}`)));
    }, decision.delayMs);
    timer.unref?.();
    continueTimers.set(sessionId, timer);
  }

  // 提醒人类：有滴答工作就挂起它（优先级清零 + 🙋 提醒）；只有 dsh 原生任务时在绑定清单建一条 🙋 提醒。
  async function notifyHuman(agent: DshAgent, reason: string): Promise<void> {
    const sessionId = agent.session.id;
    const runtime = getSessionRuntime(sessionId);
    if (!runtime) {
      log.warn(`会话 ${sessionId.slice(0, 16)} 未绑定滴答清单，无法发送提醒：${reason}`);
      return;
    }
    try {
      const work = ownWork(sessionId);
      if (work) {
        updateSessionWork(sessionId, await repository.waitForHuman(runtime.scope, work.remote.id, reason));
      } else {
        await repository.createHumanReminder(runtime.scope, `dsh 会话：${agent.session.header.cwd ?? sessionId}`, reason);
      }
    } catch (error) {
      log.warn(`滴答提醒创建失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- 空闲轮询：等价 Pi Poller，只在 agent 空闲时领取到期工作 ----
  async function poll(agent: DshAgent): Promise<void> {
    const sessionId = agent.session.id;
    const runtime = getSessionRuntime(sessionId);
    if (!runtime || agent.status !== "idle" || continueTimers.has(sessionId)) return;
    const sync = await repository.syncOpenWorks(runtime.scope, { adoptUnmanaged: true, deferFinalizationWorkIds: pendingWorkFinalizations(sessionId) });
    updateSessionWorks(sessionId, sync.works, runtime.work?.remote.id);
    const executable = sync.works.filter(isExecutableWork);
    if (!executable.length || agent.status !== "idle") return;
    const fingerprint = queueFingerprint(executable, sync.finalizationFailures.map((failure) => failure.workId));
    if (lastPolled.get(sessionId) === fingerprint) return;
    lastPolled.set(sessionId, fingerprint);
    const selected = selectPolledWork(executable);
    if (selected) {
      updateSessionWork(sessionId, selected);
      touchedWork.set(sessionId, (touchedWork.get(sessionId) ?? new Set()).add(selected.remote.id));
    }
    setQueueCheckPermission(sessionId, true);
    const text = [
      `${TODO_AUTO_POLL_PREFIX}此消息由 dida-todo 可信 Poller 生成，授权本轮同步、领取并按顺序执行所有符合条件的工作；不要处理 priority=0 草稿。`,
      "",
      formatWorkQueueForAgent(sync.works, sync.adoptedWorkIds.length, sync.acceptances, sync.finalizationFailures),
    ].join("\n");
    ctx.agents.withoutInitiator(() => agent.followup(userMessage(text, "dida-todo", "dida-todo poll")));
  }

  ctx.on("agent/created", ({ agent }: { agent: DshAgent }) => { void attach(agent); });
  ctx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => {
    const sessionId = agent.session.id;
    clearTimeout(continueTimers.get(sessionId));
    continueTimers.delete(sessionId);
    continueAttempts.delete(sessionId);
    touchedWork.delete(sessionId);
    lastTodos.delete(sessionId);
    lastPolled.delete(sessionId);
    removeSessionRuntime(sessionId);
  });
  ctx.on("agent/status", ({ agent, status }: { agent: DshAgent; status: string }) => {
    if (status === "idle") void settle(agent);
  });
  // 会话首次活动时补绑定（dsh 恢复冷会话时不一定先发 agent/created 给已加载插件）。
  ctx.on("agent/status", ({ agent }: { agent: DshAgent }) => { void attach(agent); });
  // 用户亲自发消息 = 人回来了：撤掉待发的自动续跑，计数清零。精确“检查todo”授予队列权限。
  ctx.on("agent/inbox/inserted", ({ agent, message }: { agent: DshAgent; message: DshMessage }) => {
    if (message.source.kind !== "user") return;
    const sessionId = agent.session.id;
    clearTimeout(continueTimers.get(sessionId));
    continueTimers.delete(sessionId);
    continueAttempts.delete(sessionId);
    const text = message.content.map((block) => block.text ?? "").join("");
    if (shouldCheckTodoInput(text)) setQueueCheckPermission(sessionId, true);
  });
  ctx.on("session/event", (session: { id: string }, event: { type: string; data?: { reason?: { kind: string; error?: { message?: string } }; todos?: Array<{ content?: string; status?: string }> } }) => {
    if (event.type === "todo/write" && Array.isArray(event.data?.todos)) lastTodos.set(session.id, event.data.todos);
    if (event.type === "turn/start") lastTurnStartAt.set(session.id, Date.now());
    if (event.type !== "turn/end") return;
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    const reason = event.data?.reason;
    if (!reason) return;
    if (reason.kind === "completed") continueAttempts.delete(session.id);
    scheduleContinuation(agent, { kind: reason.kind, ...(reason.error?.message ? { message: reason.error.message } : {}) });
  });

  ctx.effect(() => {
    // 插件加载前已存在的会话（热重载）也要接管。
    for (const agent of ctx.agents.list()) void attach(agent);
    const timer = pollEnabled
      ? setInterval(() => {
        for (const agent of ctx.agents.list()) {
          void poll(agent).catch((error) => log.warn(`轮询失败：${error instanceof Error ? error.message : String(error)}`));
        }
      }, pollMs)
      : undefined;
    timer?.unref?.();
    return () => {
      if (timer) clearInterval(timer);
      for (const pending of continueTimers.values()) clearTimeout(pending);
      continueTimers.clear();
    };
  });
  log.info(`已加载：自动续跑上限 ${policy.maxAttempts} 次，轮询${pollEnabled ? `每 ${pollMs / 60_000} 分钟` : "关闭"}`);
}
