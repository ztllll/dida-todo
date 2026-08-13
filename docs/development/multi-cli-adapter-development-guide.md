# dida-todo 多 CLI Adapter 开发手册

> 面向后续 LLM、维护者和贡献者的可执行开发入口。本文不是功能承诺；当前正式发布仍只支持 Pi。

最后核验：2026-08-13

当前正式 Runtime：`v0.6.13`

本文基线提交之前的 `main`：`3132bad`

优先目标：OpenClaw 原生 Adapter

后续目标：Claude Code Adapter、Codex CLI Adapter

## 0. 给接手 LLM 的 90 秒入口

开始任何实现前，按顺序完整阅读：

1. [`README.md`](../../README.md)：当前用户行为和诚实限制；
2. [`CONTEXT.md`](../../CONTEXT.md)：固定领域词汇；
3. [`docs/adr/0001-host-neutral-core-with-isolated-cli-adapters.md`](../adr/0001-host-neutral-core-with-isolated-cli-adapters.md)：不可随意推翻的架构决策；
4. [`docs/research/2026-08-13-multi-cli-adapter-feasibility.md`](../research/2026-08-13-multi-cli-adapter-feasibility.md)：第一方能力证据和兼容性矩阵；
5. 本文；
6. `extensions/dida-todo/index.ts`、`repository.ts`、`runtime.ts`、`tool.ts`、`work-tool.ts`；
7. 与本次改动相关的全部测试。

然后运行：

```bash
npm ci
npm run check
git diff --check
npm audit --omit=dev
```

若基线不通过，先诊断环境或已有改动，不得把失败归因于尚未开始的 Adapter 工作。

### 一句话设计

```text
复杂的 Todo/Dida 行为进入 Host-neutral Todo Engine；
宿主差异留在独立 Host Adapter；
Pi Adapter 在新 Adapter 被真实验证前保持冻结兼容。
```

### 当前明确不做

- 不把 OpenClaw/Claude/Codex 分支写进现有 `index.ts`；
- 不让其他 CLI 直接加载 Pi Extension；
- 不让 Skill 或提示词承担权限门；
- 不默认共享 Pi 的 Dida project；
- 不恢复普通后台 Poller；
- 不伪造 Pi Overlay parity；
- 不在没有真实宿主验收时宣称“已支持”；
- 不在忙碌的 Pi/OpenClaw/Claude/Codex 运行实例上覆盖共享安装目录。

## 1. 成功标准

多 CLI 项目只有同时满足以下条件才算成功：

1. Pi 的公开工具名、命令、Overlay、配置格式、错误语义和 Dida 数据保持兼容；
2. Host-neutral Todo Engine 不导入任何具体宿主 SDK；
3. 每个 Host Adapter 独立安装、升级、禁用和回滚；
4. 精确 `检查todo` 授权由可信宿主事件产生，模型不能伪造；
5. mutation 不扫描其他顶层工作；
6. finalization 只发生在宿主确认的自然最终回复边界；
7. Direct/Checklist、priority、scheduling、occurrence、验收和评论身份门在各宿主一致；
8. 首版 Adapter 默认使用独立 project/binding namespace；
9. 同宿主并发继续使用兼容锁协议；
10. 每个 Adapter 有 fake-host contract tests 和真实宿主 acceptance；
11. 文档明确宿主差异，不用“兼容”掩盖降级行为。

## 2. 仓库基线与保护线

### 2.1 当前 Pi 用户接口

Pi Adapter 公开：

```text
todo
todo_work
dida_todo_setup
/todos
Ctrl+Shift+T Overlay 折叠/展开
```

只有用户输入 trim 后完整等于：

```text
检查todo
```

才授权整队列同步与 `todo_work list/switch/next/refresh`。

这些接口在多 CLI 首轮开发中视为冻结契约。其他宿主应使用 namespaced 工具，不要求 Pi 跟随改名。

### 2.2 当前 Dida 数据契约

必须保留：

- `WorkMetadata v2`；
- `origin`、`lifecycle`、`workType`；
- execution claim 与 occurrence；
- `metadata.resolution`；
- Direct 内部 Execution Steps；
- Checklist 远端 Items；
- acceptance 的 `sourceWorkId + sourceOccurrence`；
- OAuth comment `userId` 身份门；
- priority `0/1/3/5`；
- `startDate/dueDate/timeZone/isAllDay/repeatFlag`；
- 完成前父子状态读回验证。

在 Adapter 隔离完成前，不要升级 schema。特别是不要为了加 `adapterId` 立即写 schema v3；先让新 Adapter 使用独立 project，证明 Host Adapter seam 后再设计共享项目迁移。

### 2.3 当前并发契约

同宿主写操作使用：

- Pi 的文件 mutation queue；
- `withHostLock()` 原子目录锁；
- 临界区内重读 Dida；
- 幂等 acceptance matching。

抽取中立 core 时，锁路径、锁 key 和数据写入顺序必须保持兼容。若 Node MutationQueue 与 Pi MutationQueue 同时存在，不能让它们各自认为自己拥有唯一串行权；最终同一资源必须经过同一 host-lock。

### 2.4 保护基线命令

每个开发 PR 开始和结束都运行：

```bash
npm run check
git diff --check
npm audit --omit=dev
```

并证明 Pi Runtime 没有意外改动：

```bash
git diff --name-only -- extensions/dida-todo
```

如果 PR 的目标不是迁移 Pi Adapter，以上输出中不应出现 Pi Runtime 文件。

若 PR 必须修改 Pi Runtime，PR 描述必须逐项列出：

- 修改的公开行为；
- 对应旧测试；
- 新增对抗测试；
- 真实 Pi Loader/RPC/TUI 验证；
- 回滚方式。

## 3. 当前模块地图

### 3.1 基本宿主中立，可迁入 Core

以下模块当前没有直接导入 Pi SDK：

```text
acceptance-result.ts
acceptance.ts
codec.ts
compatibility.ts
config.ts
domain.ts
host-lock.ts
input-sync.ts
provisioning-identity.ts
scheduling.ts
settled-finalization.ts
status.ts
tracking-policy.ts
work-finalizer.ts
work-lifecycle.ts
work-queue.ts
work-type.ts
```

注意“没有 Pi import”不等于可以机械移动：

- `config.ts` 的默认路径仍是 Pi 产品语义；
- `settled-finalization.ts` 接受的 Repository 类型需改为 Core interface；
- `acceptance-result.ts` 的调用时机由宿主 Adapter 决定；
- `input-sync.ts` 只负责纯匹配，不负责授予权限。

### 3.2 含少量可替换基础设施依赖

```text
gateway.ts       -> pi.exec
repository.ts    -> withFileMutationQueue
provisioning.ts  -> withFileMutationQueue
tmuxbot-route.ts -> pi.exec
poller.ts        -> Pi 类型；当前实现 no-op
```

这些模块优先通过 seam 解耦，不要复制一份“OpenClawRepository”“ClaudeRepository”。

### 3.3 明确属于 Pi Adapter

```text
index.ts
commands.ts
overlay.ts
runtime.ts
setup-tool.ts
tool.ts
work-tool.ts
```

它们拥有 Pi 的 lifecycle、tool schema、UI 和 session Runtime。首轮不得移动或大规模改写。

## 4. 目标目录结构

推荐最终结构：

```text
packages/
├── core/
│   ├── src/
│   │   ├── engine.ts
│   │   ├── domain.ts
│   │   ├── repository.ts
│   │   ├── gateway.ts
│   │   ├── process-runner.ts
│   │   ├── mutation-queue.ts
│   │   ├── turn-grant.ts
│   │   ├── scheduling.ts
│   │   ├── lifecycle.ts
│   │   ├── acceptance.ts
│   │   └── provisioning.ts
│   └── tests/
├── adapter-pi/
│   ├── src/
│   │   ├── index.ts
│   │   ├── tools.ts
│   │   ├── lifecycle.ts
│   │   ├── overlay.ts
│   │   └── process-runner.ts
│   └── tests/
├── adapter-openclaw/
│   ├── src/
│   ├── openclaw.plugin.json
│   └── tests/
├── adapter-claude-code/
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   ├── hooks/hooks.json
│   ├── skills/
│   ├── server/
│   └── tests/
└── adapter-codex/
    ├── .codex-plugin/plugin.json
    ├── hooks/hooks.json
    ├── skills/
    ├── server/
    └── tests/
```

### 4.1 不要一开始就搬目录

Phase 1 推荐先在现有 `extensions/dida-todo/` 内引入中立 interface，并保持文件位置不变。过早 monorepo 化会把“行为保持重构”和“构建系统迁移”混成一个 PR，难以审查和回滚。

只有两个真实 Adapter 都调用同一 Core 后，`packages/core` seam 才真正成立。遵循：

> 一个 Adapter 是假设；两个 Adapter 才证明 seam 真实存在。

## 5. Core 外部 Interface

目标是深模块：调用者只提交宿主事实，不理解 Dida 内部状态机。

建议最小 interface：

```ts
export interface TodoEngine {
  openSession(input: OpenSessionInput): Promise<OpenSessionResult>;
  prepareTurn(input: PrepareTurnInput): Promise<PrepareTurnResult>;
  executeTool(input: ExecuteToolInput): Promise<ExecuteToolResult>;
  finalizeTurn(input: FinalizeTurnInput): Promise<FinalizeTurnResult>;
  closeSession(input: CloseSessionInput): Promise<void>;
}
```

### 5.1 宿主事实

```ts
export type AdapterId = "pi" | "openclaw" | "claude-code" | "codex";

export interface HostSessionIdentity {
  adapterId: AdapterId;
  hostId: string;
  sessionId: string;
  cwd: string;
  route?: {
    channel?: string;
    accountId?: string;
    conversationId?: string;
    threadId?: string;
  };
}

export interface HostTurnIdentity {
  session: HostSessionIdentity;
  turnId: string;
  runId?: string;
}
```

所有字段来自宿主可信事件。MCP tool 参数中的同名字符串不能覆盖它们。

### 5.2 `prepareTurn`

```ts
export interface PrepareTurnInput {
  identity: HostTurnIdentity;
  userText: string;
  source: "user" | "cron" | "heartbeat" | "system";
}

export interface PrepareTurnResult {
  additionalContext?: string;
  queueGrantIssued: boolean;
  grantHandle?: string; // only for Adapter internals; never model-authored
  notices: Array<{ level: "info" | "warning" | "error"; text: string }>;
}
```

不变量：

- 只有 `source === "user"` 且 `userText.trim() === "检查todo"` 才签发 queue grant；
- mutation 意图不签发 queue grant；
- cron/heartbeat 默认不签发；
- Dida 外部文本始终包在不可信数据标记内；
- grant 签发失败时队列检查 fail closed。

### 5.3 `executeTool`

```ts
export interface ExecuteToolInput {
  identity: HostTurnIdentity;
  tool: "todo" | "todo_work" | "dida_todo_setup";
  action: string;
  arguments: Record<string, unknown>;
  trustedGrantHandle?: string;
}
```

Engine 必须自行判断哪些 action 需要 queue grant：

```text
todo create/update/get/list/delete/clear -> 不要求 queue grant
todo_work finish_current                 -> 只收口当前工作，不要求整队列 grant
todo_work list/switch/next/refresh       -> 必须消费当前 turn queue grant
```

不能由 Adapter 传入 `queueAuthorized: true` 这种可误用 Boolean。

### 5.4 `finalizeTurn`

```ts
export interface FinalizeTurnInput {
  identity: HostTurnIdentity;
  outcome: "success" | "error" | "interrupted";
  finalAssistantText?: string;
  stopHookActive?: boolean;
  hasActiveTools: boolean;
  hasPendingBackgroundWork: boolean;
}

export type FinalizeTurnResult =
  | { action: "finalize"; acceptanceUpdates: number }
  | { action: "continue"; reason: string }
  | { action: "defer"; reason: string }
  | { action: "ignore" };
```

不变量：

- error/interrupted 不收口；
- 有 active tool/background work 时 defer；
- Checklist 出现新的 pending/in_progress Item 时 continue/defer；
- 最终回复为空、仅工具调用或不稳定时不回填；
- 远端 finalization 失败时源工作保持未完成；
- `stopHookActive` 防止无限 continue loop；
- Adapter 将 `continue` 映射为宿主的 revise/block 语义。

## 6. 基础设施 seam

### 6.1 ProcessRunner

```ts
export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}
```

Adapter：

- `PiProcessRunner` 包装 `pi.exec`；
- `NodeProcessRunner` 使用 `spawn`，必须有 stdout/stderr 1 MiB 限制、超时和 AbortSignal；
- 测试使用 `FakeProcessRunner`。

首个 PR 只引入 interface 和 Pi Adapter，输出必须与旧 `gateway.test.ts` 完全一致。

### 6.2 MutationQueue

```ts
export interface MutationQueue {
  run<T>(key: string, action: () => Promise<T>): Promise<T>;
}
```

要求：

- Repository/Provisioning 不导入 Pi SDK；
- `MutationQueue` 只管理进程内排队；
- `withHostLock` 继续管理跨进程串行；
- lock 内必须重读远端；
- Adapter 不能跳过 host lock；
- fake queue 必须可证明并发调用顺序。

### 6.3 Clock 与 ID

只有测试确实需要时才抽：

```ts
interface Clock { now(): Date }
interface IdGenerator { randomId(): string }
```

不要为“未来可能需要”提前把所有 Node 内建函数都接口化。

## 7. Turn Grant 协议

Turn Grant 是本项目多宿主适配中最重要的安全模块。

### 7.1 Grant 内容

```ts
interface TurnGrantClaims {
  version: 1;
  adapterId: AdapterId;
  hostId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  bindingKey: string;
  purpose: "queue-check";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}
```

建议 TTL：2–5 分钟，取决于 Hook 到首次工具调用的最长真实延迟。TTL 必须配置上限，不能接受模型传入。

### 7.2 Grant 存储

优先选择宿主本地私有目录中的一次性记录，而不是把 bearer token放进模型上下文：

```text
~/.config/dida-todo/grants/<hash>.json
mode 0600
```

或 Adapter 提供的持久私有数据目录：

- Claude：`${CLAUDE_PLUGIN_DATA}`；
- Codex：`PLUGIN_DATA`；
- OpenClaw：插件私有 state；
- Pi：现有 session Runtime，可暂不迁移到跨进程 grant。

### 7.3 签发与消费

```text
UserPromptSubmit/message_received
→ Engine.prepareTurn 精确匹配
→ GrantStore.issue(claims)
→ Hook 私下保存 grantHandle
→ PreToolUse/原生 tool context 附加 handle
→ MCP/Engine.executeTool 验证全部 claims
→ 原子 consume
→ 执行一次队列读取
```

必须防止：

- replay；
- session A 使用 session B grant；
- Claude grant 给 Codex；
- cwd/binding 改变后继续使用；
- grant 文件符号链接/权限绕过；
- 模型直接把旧 handle 写进参数；
- 并行 `todo_work list` 重复消费；
- expired grant 被容错放行。

### 7.4 PreToolUse 不是唯一安全门

Claude/Codex 的 PreToolUse 可以注入可信字段，但 Engine/MCP Server 仍必须验证。原因：

- Hook 可能未获 trust；
- Hook 可能被禁用；
- 某些 specialized/hosted tool path 可能绕过默认 Hook；
- 用户可能直接调用 MCP Server；
- Adapter bug 可能遗漏注入。

安全门必须在最靠近远端 mutation/read 的 Engine 内 fail closed。

## 8. Adapter Namespace 与项目隔离

### 8.1 首版默认命名

```text
[hostname][adapter][channel?] route-or-cwd
```

示例：

```text
[host-a][openclaw][telegram] project-route
[host-a][claude-code] repository-name
[host-a][codex] repository-name
```

Pi 继续使用当前已发布命名和 binding，不自动迁移。

### 8.2 配置隔离

建议：

```text
Pi        ~/.config/pi-dida-todo/config.json
OpenClaw  OpenClaw plugin private config/state
Claude    ${CLAUDE_PLUGIN_DATA}/config.json
Codex     ${PLUGIN_DATA}/config.json
```

不要让其他 Adapter 直接读写 Pi config。若未来需要导入，必须提供显式只读 preview 和确认后的迁移命令。

### 8.3 共享项目禁止线

schema v2 没有 adapter-aware execution ownership。首版必须拒绝：

- 根据相同 cwd 自动复用 Pi project；
- 复制 Pi binding 到另一个 Adapter；
- 在 Pi 工作处于 claimed/running 时由其他 Adapter 接管；
- 多 Adapter 对同一 acceptance 做 feedback/finalization。

未来 Shared Project 至少需要：

```ts
execution.owner = {
  adapterId,
  hostId,
  sessionId,
  turnId?,
  claimedAt,
  leaseUntil?
}
```

并设计 stale lease、人工强制接管、跨宿主限制和 schema migration。另立 ADR，不要顺手加入首个 Adapter PR。

## 9. Pi Adapter 迁移策略

### 9.1 首选：先旁路，不迁移

OpenClaw Prototype 可以临时消费抽取出的纯模块，但 Pi 入口继续用当前实现。只有遇到必须共享的逻辑时才抽 seam。

### 9.2 如果必须改 Pi

采用 replace-don't-layer：

1. 先在现有测试 seam 写行为测试；
2. 引入中立 interface；
3. Pi Adapter 实现 interface；
4. 旧调用点一次性切换；
5. 删除旧并行实现；
6. 不保留两套“临时兼容路径”。

### 9.3 Pi 契约测试清单

至少保留以下现有测试：

```text
input-sync.test.ts
tracking-policy.test.ts
todo-create-bootstrap.test.ts
work-tool.test.ts
runtime-priority.test.ts
settled-finalization.test.ts
finish-acceptance.test.ts
checklist-work-completion.test.ts
lifecycle-red.test.ts
multiprocess-repository.test.ts
poller-resilience.test.ts
overlay.test.ts
commands-ready.test.ts
extension-load.test.ts
real-dida.candidate.test.ts（opt-in）
```

迁移 Core 后，新增 Adapter contract tests，但不要删除这些用户可观察回归测试，直到新的测试从 Pi 入口覆盖完全等价行为。

## 10. OpenClaw Adapter：首个原型

### 10.1 为什么先做

OpenClaw 提供最完整宿主事实：

- 原生 Tool registration；
- channel message/route/media；
- sessionKey/sessionId/runId；
- before prompt/tool/finalize；
- agent_end；
- Gateway lifecycle；
- 插件独立安装和 runtime inspection。

### 10.2 建议插件能力

工具名：

```text
dida_todo
dida_todo_work
dida_todo_setup
```

Hooks：

| OpenClaw Hook | Adapter 行为 |
| --- | --- |
| `message_received` | 捕获可信入站文本/route；不直接读 Dida |
| `before_agent_run` 或 `before_prompt_build` | 调用 `prepareTurn`；精确口令时注入队列上下文 |
| `before_tool_call` | 注入可信 session/run/binding；执行 tool policy |
| `after_tool_call` | 更新 Adapter 可观察状态；不自行 finalization |
| `before_agent_finalize` | 调用 `finalizeTurn`；返回 continue/revise/finalize |
| `agent_end` | 成功后回填最终回复、清理 turn grant |
| `session_start` | 恢复绑定和只读快照 |
| `session_end` | 有界清理；不得在短 shutdown budget 做长远端写入 |
| `gateway_start/stop` | 启停 Adapter 私有资源 |
| `message_sending/reply_payload_sending` | 文件/图片交付适配 |

### 10.3 Conversation Hook 权限

OpenClaw 非 bundled plugin 使用原始 conversation hooks 时需要明确 operator 配置。Prototype 必须：

- 文档列出最小 allow 配置；
- 缺少授权时 fail closed；
- `openclaw plugins inspect <id> --runtime --json` 证明 hooks/tools 已注册；
- 不自动扩大插件权限；
- 不启用 cron。

### 10.4 OpenClaw Prototype 验收

隔离环境至少验证：

1. 普通聊天新增 0 Todo；
2. `检查 todo` 不扫描；
3. `检查todo` 注入队列；
4. mutation 调用不扫描；
5. Direct priority=1/3/5；
6. Checklist Item 完成不提前收口；
7. finalize 前新增 Item 导致 revise；
8. 最终回复精确回填；
9. 一个 source 只有一个 acceptance；
10. route/channel 附件回传；
11. Gateway restart 后恢复；
12. Pi project 数量和内容不变。

## 11. Claude Code Adapter

### 11.1 插件布局

```text
adapter-claude-code/
├── .claude-plugin/plugin.json
├── .mcp.json
├── hooks/hooks.json
├── hooks/*.mjs
├── skills/dida-todo/SKILL.md
├── server/index.mjs
├── package.json
├── package-lock.json
└── tests/
```

使用 Marketplace/cache 安装，不引用 Pi checkout。依赖安装必须适配 Claude Plugin 的 `npm ci --ignore-scripts` 规则；不要依赖 postinstall 编译。

### 11.2 Hook 映射

| Claude Hook | Adapter 行为 |
| --- | --- |
| `SessionStart` | 加载 Adapter config，恢复 binding，注入简短状态 |
| `UserPromptSubmit` | 读取原始 `prompt`，签发 Turn Grant，注入队列上下文 |
| `PreToolUse` | 仅匹配 dida-todo MCP tools；注入可信 hostContext/grant |
| `PostToolUse` | 记录结果/错误；必要时提供追加上下文 |
| `Stop` | 使用 `last_assistant_message` 调用 `finalizeTurn`；block 时让 Claude 继续 |
| `StopFailure` | 只记录失败，不收口 |
| `SessionEnd` | 快速清理 grant；不做长远端 finalization |

### 11.3 Stop Hook 防循环

必须读取 `stop_hook_active`。当 Engine 仍要求继续但 Hook 已 active 时：

- 若远端状态确有变化，可允许一次有界继续；
- 若同一 reason/remote revision 未变化，停止重复 block 并报告可观察错误；
- 不依赖 Claude 的 8 次上限作为业务重试策略。

### 11.4 Claude 验收

除共同 contract 外，验证：

- Plugin validate；
- Marketplace install；
- MCP server status；
- project trust；
- `/reload-plugins` 前后版本隔离；
- `last_assistant_message` 与最终 Dida desc 精确一致；
- transcript 落后时仍不误读；
- hooks disabled/untrusted 时 queue action fail closed；
- 无 Pi Overlay 时文档不误称完整 UI parity。

## 12. Codex Adapter

### 12.1 插件布局

```text
adapter-codex/
├── .codex-plugin/plugin.json
├── hooks/hooks.json
├── hooks/*.mjs
├── skills/dida-todo/SKILL.md
├── server/index.mjs
├── package.json
├── package-lock.json
└── tests/
```

### 12.2 Hook 映射

| Codex Hook | Adapter 行为 |
| --- | --- |
| `SessionStart` | 加载 config/binding，注入简短恢复上下文 |
| `UserPromptSubmit` | 使用 `session_id + turn_id + prompt` 签发 grant |
| `PreToolUse` | 对 MCP tool 注入/验证可信上下文 |
| `PostToolUse` | 记录工具结果 |
| `Stop` | 使用 `last_assistant_message` 和 `stop_hook_active` 调用 finalization |
| `SessionEnd` | 在 1–3 秒预算内只做本地清理 |

### 12.3 Codex 特有安全要求

- 安装/更新后的 hooks 必须完成人类 trust review；
- 不使用 `--dangerously-bypass-hook-trust` 作为普通安装说明；
- Hook 未 trust 时 MCP Server 自身必须拒绝 queue action；
- specialized/hosted tool 可能不走默认 Hook，所以 Engine 验证不可省略；
- oversized Hook output 会 spill，队列上下文必须截断并避免秘密；
- background Hook 不能控制当前操作，不用于授权签发或 finalization。

### 12.4 Codex 验收

验证：

- local marketplace/plugin install；
- `/hooks` trust 状态；
- MCP stdio startup；
- exact phrase grant；
- near-match rejection；
- Stop continuation；
- session resume/compact；
- Plugin update 后旧 session 行为；
- direct MCP call 无 grant 时 fail closed。

## 13. Degraded MCP Mode

如果某宿主只支持 MCP，没有可信 input/finalization hooks：

允许：

- 显式按 ID 读取一个工作；
- mutation 当前明确工作；
- status/list 的只读降级接口（需独立显式调用和审批）；
- setup/login。

禁止：

- 自动识别 `检查todo`；
- 整队列自动执行；
- 自动 finalization；
- 最终回复回填；
- 声称唯一验收不变量与完整 Adapter 等价。

工具返回必须包含：

```text
当前宿主缺少可信 input/finalization lifecycle；这是 Degraded MCP Mode，不执行自动队列与收口。
```

## 14. TDD 实施顺序

所有实现使用红→绿→重构。

### Phase 1A：ProcessRunner

红：

- `DidaCliGateway` 可使用不依赖 Pi 的 Fake runner；
- timeout、AbortSignal、1 MiB 输出和错误截断保持原行为。

绿：

- 引入 `ProcessRunner`；
- `PiProcessRunner` 包装 `pi.exec`；
- 不改 gateway argv。

验证：

```bash
npm run typecheck
npx vitest run tests/dida-todo/gateway.test.ts
npm run check
```

### Phase 1B：MutationQueue

红：

- Repository/Provisioning 在无 Pi SDK fake host 下并发安全；
- 同 key 串行，不同 key 可并行；
- host lock 仍保留。

绿：

- 注入 `MutationQueue`；
- Pi Adapter 实现旧 queue 语义；
- Node Adapter 实现中立 queue。

### Phase 1C：Turn Grant

先写对抗测试：

- exact phrase 签发；
- near match 不签发；
- wrong adapter/session/turn/cwd 拒绝；
- expired/replayed grant 拒绝；
- 并行消费只成功一次；
- mutation 不需要 queue grant；
- queue action 无 grant 在任何远端调用前拒绝。

### Phase 1D：TodoEngine

用 FakeHost Adapter 证明：

- open/prepare/tool/finalize/close 完整路径；
- 现有 Repository 结果不变；
- finalization error 保持源工作 open；
- final response only after trusted finalize boundary。

### Phase 2：OpenClaw

先用 Fake OpenClaw events 测 Adapter，再用真实插件开发模式验收。不得先改 Pi Adapter 来配合 OpenClaw。

## 15. 测试矩阵

### 15.1 Core Contract

| 场景 | 必测结果 |
| --- | --- |
| 普通聊天 | 不建 Todo、不签 grant |
| exact `检查todo` | 签一次性 grant，注入可执行队列 |
| near match | 不签 grant |
| mutation | 只操作目标，不扫描 |
| priority 0 | 用户草稿静默 |
| Pi 历史 priority 0 | 迁移 low，数据保留 |
| timed future | 可同步但不可执行 |
| recurring next occurrence | 需要新 claim |
| Direct complete | settled 后收口 |
| Checklist Item complete | 不代表顶层完成 |
| append after ready | 回到 claimed |
| acceptance race | 恰好一个 acceptance |
| unauthorized comment | 静默忽略 |
| same-user comment | 独立 rework |

### 15.2 Adapter Contract

所有 Adapter 用同一测试向量：

```ts
interface HostAdapterContract {
  submitUserText(text: string): Promise<ObservedTurn>;
  invokeTool(name: string, args: unknown): Promise<ObservedToolResult>;
  finishWith(text: string): Promise<ObservedFinalization>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
}
```

断言宿主可观察行为，不断言内部类名或文件布局。

### 15.3 真实 Dida 门

必须使用：

- 唯一测试前缀；
- 隔离 project；
- `finally` 清理；
- 不记录真实 project/task/user/OAuth ID；
- 不指向 Pi 正式 project；
- 失败时保存去身份化诊断。

### 15.4 真实宿主门

每个 Adapter 至少验证：

- 安装；
- enable/trust；
- session start；
- exact/near-match input；
- tool mutation；
- Stop/finalize；
- reload/restart；
- uninstall/disable；
- Pi 安装和 Dida project 不变。

## 16. 安全审计

每个 PR 检查：

```bash
git diff --check
npm audit --omit=dev
rg -n '(access_token|refresh_token|PRIVATE KEY|chat_id|thread_id)' . \
  --glob '!node_modules/**' --glob '!*.md'
```

额外要求：

- OAuth 配置不进入 plugin package；
- grant 文件 `0600`；
- plugin data path 不使用用户输入拼接；
- Dida title/content/comment 一律不可信；
- Hook additionalContext 不能包含 secret/grant；
- MCP Tool schema 使用严格枚举；
- 工具失败抛异常/返回协议错误，不伪装成功；
- 输出截断并提供完整诊断文件路径；
- session end/shutdown 不执行超预算远端操作；
- 安装说明使用 pinned tag/commit；
- 非交互 bypass trust/yolo 参数不得进入默认文档。

## 17. 发布单元与版本策略

每个宿主独立发布：

```text
Pi Package tag
OpenClaw plugin package/tag
Claude Code marketplace plugin version
Codex marketplace plugin version
Core internal/shared package version
```

要求：

- 一个 Adapter 更新不覆盖另一个 Adapter 的安装目录；
- Core breaking change 先升级 Adapter contract tests；
- Pi 版本只在 Pi Runtime 或 Pi 打包内容变化时发布；
- 纯研究文档可提交 `main`，不必制造空 Runtime tag；
- Adapter alpha 不使用正式 Pi project；
- Release notes 明确宿主、最低版本、trust/reload 步骤和已知降级。

## 18. 推荐 Issue 拆分

### Issue 1：冻结 Pi Contract Suite

产物：

- 当前工具 schema snapshot；
- input/finalization/overlay contract tests；
- v0.6.13 真实验收记录；
- 不改生产代码。

### Issue 2：抽取 ProcessRunner

产物：中立 runner + Pi runner + fake runner，gateway 行为零变化。

### Issue 3：抽取 MutationQueue

产物：Repository/Provisioning 不再导入 Pi SDK；并发测试通过。

### Issue 4：实现 TurnGrantStore

产物：签发、验证、一次性消费、TTL、跨 Adapter 防串用测试。

### Issue 5：建立 TodoEngine facade

产物：最小 interface 和 FakeHost contract tests；Pi 尚不迁移 UI。

### Issue 6：OpenClaw Plugin Skeleton

产物：独立 package、manifest、注册只读 status tool、runtime inspect。

### Issue 7：OpenClaw exact-input + tool path

产物：message/turn hooks、grant、mutation、隔离 project。

### Issue 8：OpenClaw finalization + attachment

产物：before finalize/agent_end、唯一验收、文件交付真实验收。

### Issue 9：Claude Code Prototype

产物：Plugin + MCP + hooks + trust/reload 验收。

### Issue 10：Codex Prototype

产物：Plugin + MCP + hooks + trust/Stop 验收。

不要把 Issue 2–8 合并成一个“大重构 + 新插件”PR。

## 19. PR 模板

每个多 CLI PR 描述至少包含：

```text
目标宿主：
改动 Phase/Issue：
改动的 seam：
是否修改 Pi Runtime：是/否
是否修改 Dida schema：是/否
是否访问真实 Dida：项目隔离说明
精确口令测试：
mutation 不扫描测试：
Stop/finalization 测试：
并发测试：
安装/reload 测试：
失败回退：
已知降级：
```

若“是否修改 Pi Runtime”为是，必须附 Pi TUI/RPC/Loader 实证。

## 20. LLM 交接模板

上下文过大或切换 Agent 时，在仓库外或指定维护文档记录：

```text
当前 Phase/Issue：
当前 branch/commit：
工作区状态：
已修改文件：
红测：
绿测：
全量检查：
真实 Dida 临时项目是否清理：
真实宿主安装是否清理：
Pi Runtime 是否修改：
Pi 正式项目是否触碰：
剩余风险：
下一条可执行命令：
```

不要只写“继续实现 Adapter”。下一位必须能从一条命令恢复。

## 21. 开发中常见误判

### “三个宿主都支持 MCP，所以写一个 Server 就结束了”

错误。MCP 解决工具调用，不自动提供可信原始 input、Stop/finalization、route、UI、安装和版本隔离。

### “Stop Hook 触发了，所以任务一定完成”

错误。Stop 表示自然回复即将结束，不表示所有用户要求已完成。Engine 必须重读远端和 lifecycle，并检查 background/tool state。

### “同 cwd 就应该共享一个 Dida project”

错误。cwd 是项目位置，不是跨 Adapter execution ownership。

### “同宿主有文件锁，所以多个 CLI 可以安全抢同一工作”

错误。锁保证写入串行，不决定谁有业务执行权。

### “Skill 里写禁止扫描就够安全”

错误。Skill 是模型上下文，不是远端访问前的强制门。

### “其他 CLI 没 Overlay 就做一个定时 Poller 补偿”

错误。UI 缺失与后台执行是不同问题；不能违反 exact-phrase 产品决策。

### “先把 Pi 全部抽到 Core，再做 Adapter”

风险高。没有第二个 Adapter 的真实调用，Core seam 很可能按想象设计，且一次性暴露 Pi 全回归面。优先做最小 seam + OpenClaw 旁路原型。

## 22. Definition of Done

一个新 Host Adapter 只有满足以下条件才能从“原型”升级为“支持”：

- [ ] 官方最低宿主版本已记录；
- [ ] 独立安装/卸载/更新流程通过；
- [ ] exact phrase 和 near-match 真实输入通过；
- [ ] mutation 不扫描通过；
- [ ] Turn Grant 对抗测试通过；
- [ ] Direct/Checklist 通过；
- [ ] priority/scheduling/recurrence 通过；
- [ ] Stop/finalization/最终回复通过；
- [ ] 唯一 acceptance 通过；
- [ ] comment identity gate 通过；
- [ ] restart/resume 通过；
- [ ] 同宿主并发通过；
- [ ] Adapter project 与 Pi project 隔离证明通过；
- [ ] 文件/附件能力按宿主真实声明；
- [ ] 不支持的 UI/后台能力明确写入限制；
- [ ] `npm run check` 和安全审计通过；
- [ ] 人类在真实宿主完成验收；
- [ ] 没有残留测试 project、task、grant、plugin install 或凭据。

未完成任一关键项时，文档只能写“experimental/prototype”，不能写“supported”。

## 23. 第一条建议执行路径

如果现在开始开发，严格按以下顺序：

```text
1. 新建分支，不部署任何宿主
2. 为 ProcessRunner 写红测
3. 引入 ProcessRunner + PiProcessRunner
4. 全量 Pi 测试
5. 为 MutationQueue 写红测
6. 移除 Repository/Provisioning 的 Pi import
7. 全量 Pi 测试 + real-Dida 隔离门
8. 为 Turn Grant 写纯 Core 对抗测试
9. 建 OpenClaw 空插件，只注册只读 status tool
10. runtime inspect，证明独立安装
11. 接 exact input 和隔离 Dida project
12. 接 tool mutation
13. 接 before finalize / agent_end
14. 真实 OpenClaw 验收
15. 再决定 Pi 是否迁移到 TodoEngine facade
```

最关键的原则：

> 新 Adapter 应证明 Core seam，而不是要求稳定 Pi 先为它重写一遍。
