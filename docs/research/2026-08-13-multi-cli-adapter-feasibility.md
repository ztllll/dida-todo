# dida-todo 多 CLI 适配可行性研究

日期：2026-08-13

范围：Pi、OpenClaw、OpenAI Codex CLI、Anthropic Claude Code

结论状态：架构研究；未实现、未安装、未部署其他 CLI adapter

## 结论

**可以适配，但不能把当前 Pi Extension 原样塞进其他 CLI，也不应把 Pi 入口改造成按宿主分支的大型条件模块。**

推荐形态是：

```text
一个仓库
├── Host-neutral Todo Engine
│   ├── Dida Repository
│   ├── lifecycle / scheduling / acceptance
│   ├── host-scoped turn authorization
│   └── cross-process mutation/finalization locks
├── Pi Adapter（保留当前已验收行为与发布单元）
├── OpenClaw Adapter（独立原生插件）
├── Claude Code Adapter（独立 Plugin + MCP + hooks）
└── Codex Adapter（独立 Plugin + MCP + hooks）
```

OpenClaw 是最适合首个完整适配的目标；Claude Code 与 Codex CLI 都能做高完整度适配。只有 MCP、没有宿主 hooks 时，只能提供降级工具能力，不能宣称与 Pi 的安全闭环等价。

本研究不建议立即改造现有 Pi 包。先建立中立契约和新 adapter 的隔离原型，Pi 继续运行当前代码；只有中立 core 通过 Pi 的全部契约测试和真实回归后，才考虑让 Pi adapter 迁移到该 core。后续实现请从根部 [`DEVELOPMENT.md`](../../DEVELOPMENT.md) 开始，并严格遵循[多 CLI Adapter 开发手册](../development/multi-cli-adapter-development-guide.md)。

## 事实来源与核验方法

以下事实来自各宿主的第一方文档或官方源码；源码引用固定到本次核验 commit，避免分支后续变化造成引用漂移。

### Pi

当前 dida-todo 直接使用 Pi Extension API 注册工具、命令、快捷键、Overlay 与生命周期事件。Pi 官方 Extension 文档说明了 `registerTool`、commands、UI 与 `session_start`、`input`、`agent_end`、`agent_settled`、`session_shutdown` 等事件：

- 本机 Pi 官方文档：`docs/extensions.md`（安装路径由 Pi 提供）
- 本仓库入口：[`extensions/dida-todo/index.ts`](../../extensions/dida-todo/index.ts)

### OpenAI Codex CLI

Codex 官方文档确认：

- Codex CLI、IDE 和桌面客户端支持 stdio/HTTP MCP Server；MCP 工具可配置审批策略。
- Codex Plugin 可以捆绑 MCP Server 与 lifecycle hooks。
- hooks 包含 `UserPromptSubmit`、`Stop`、`SessionStart/End`、`Pre/PostToolUse` 等。
- `UserPromptSubmit` 输入包含 `session_id`、`turn_id`、`cwd` 和原始 `prompt`，可注入 additional context。
- `Stop` 输入包含 `session_id`、`turn_id`、`cwd`、`stop_hook_active` 与 `last_assistant_message`，并可 block 停止、给模型 continuation prompt。
- 非受管 hooks 需要按内容 hash 完成人类 trust review。

第一方来源：

- [Codex MCP](https://developers.openai.com/codex/extend/mcp)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Codex Plugins](https://developers.openai.com/codex/build-plugins)
- [`UserPromptSubmit` 官方源码](https://github.com/openai/codex/blob/c30a3e49c9231361abeaa88d4a57bb7c3e248a50/codex-rs/hooks/src/events/user_prompt_submit.rs)
- [`Stop` 官方源码](https://github.com/openai/codex/blob/c30a3e49c9231361abeaa88d4a57bb7c3e248a50/codex-rs/hooks/src/events/stop.rs)
- [`SessionStart` 官方源码](https://github.com/openai/codex/blob/c30a3e49c9231361abeaa88d4a57bb7c3e248a50/codex-rs/hooks/src/events/session_start.rs)

### Anthropic Claude Code

Claude Code 官方文档确认：

- Plugin 可以包含 skills、agents、hooks 和 MCP servers。
- MCP 支持 stdio、HTTP、SSE 和 WebSocket；Plugin MCP Server 启用时自动连接。
- `UserPromptSubmit` 输入包含原始 `prompt`，可 block 或注入 `additionalContext`。
- `Stop` 在主 Agent 完成自然回复时触发，输入包含 `session_id`、`cwd`、`stop_hook_active`、`last_assistant_message`、后台任务和 session cron；可 block 停止并让 Claude 继续执行。
- transcript 异步写入，官方明确建议 Stop Hook 使用 `last_assistant_message`，不要通过 transcript 猜当前最终回复。
- Marketplace Plugin 使用版本隔离 cache；更新中旧 session 保持旧路径，执行 `/reload-plugins` 后切换 hooks/MCP。

第一方来源：

- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
- [Claude Code Plugin Reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference)
- [Claude Code Hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Claude Code 官方插件示例](https://github.com/anthropics/claude-code/tree/be90077c6a353f292fa612d97173865a9ab21b83/plugins)

### OpenClaw

OpenClaw 官方文档和源码确认：

- 原生 TypeScript Plugin 可通过 `api.registerTool` 注册工具。
- Plugin hooks 覆盖消息、工具、Agent turn、session、Gateway、cron 与最终交付。
- `message_received` 可观察原始入站内容、thread、sender、media 和 session/run correlation。
- `before_agent_finalize` 只在 harness 将接受自然最终回复时触发；输入包含 `sessionId`、`sessionKey`、`turnId`、`cwd`、`stopHookActive`、`lastAssistantMessage` 和 messages，可要求额外模型 pass。
- `agent_end` 可观察最终 messages、成功状态和 duration。
- settled-turn finalization contract 拒绝带工具调用、失败 stopReason、无可见文本或仍有 capability activity 的“最终结果”。
- 原生插件通过 ClawHub/npm/git/本地路径安装；安装/更新插件代码需要 Gateway restart。

第一方来源：

- [OpenClaw Building Plugins](https://github.com/openclaw/openclaw/blob/2a8b322ebf52d6d32dbf1170fc4344fee158a474/docs/plugins/building-plugins.md)
- [OpenClaw Plugin Hooks](https://github.com/openclaw/openclaw/blob/2a8b322ebf52d6d32dbf1170fc4344fee158a474/docs/plugins/hooks.md)
- [OpenClaw Plugin Management](https://github.com/openclaw/openclaw/blob/2a8b322ebf52d6d32dbf1170fc4344fee158a474/docs/plugins/manage-plugins.md)
- [OpenClaw Hook Types](https://github.com/openclaw/openclaw/blob/2a8b322ebf52d6d32dbf1170fc4344fee158a474/src/plugins/hook-types.ts)
- [OpenClaw settled finalization contract](https://github.com/openclaw/openclaw/blob/2a8b322ebf52d6d32dbf1170fc4344fee158a474/src/agents/harness/settled-turn-finalization-result.ts)

## 当前代码的可复用程度

当前 `extensions/dida-todo/` 有 29 个 TypeScript 模块。17 个模块没有直接导入 Pi 包，包括：

- domain / codec；
- tracking policy / input matching；
- scheduling / occurrence；
- lifecycle / work type；
- acceptance / acceptance result；
- work queue / finalizer；
- host lock；
- provisioning identity。

12 个模块直接依赖 Pi API 或 Pi TUI：

- `index.ts`：Pi 生命周期与输入改写；
- `tool.ts`、`work-tool.ts`、`setup-tool.ts`：Pi tool schema/registration；
- `commands.ts`、`overlay.ts`、`runtime.ts`：Pi command、UI 和 session Runtime；
- `gateway.ts`：使用 `pi.exec`；
- `repository.ts`、`provisioning.ts`：仅因 `withFileMutationQueue` 直接依赖 Pi；
- `tmuxbot-route.ts`：使用 `pi.exec`；
- `poller.ts`：类型依赖 Pi，但实现当前为 no-op。

所以不是重写整个项目。主要工作是把少量基础设施依赖从 Pi seam 移出，并为每个宿主建立独立 adapter。

## 兼容性矩阵

评级：

- **完整可行**：宿主有足够的一手接口实现当前语义，但仍需原型与真实验收。
- **高完整度**：核心闭环可实现，UI/交付或生命周期细节需要宿主特化。
- **降级可行**：能暴露工具，但不能保证当前全部不变量。
- **不应承诺**：没有可靠宿主接口。

| 能力 | Pi | OpenClaw | Claude Code | Codex CLI | 仅 MCP |
| --- | --- | --- | --- | --- | --- |
| Todo/Work 工具 | 已实现 | 完整可行，原生 tool | 高完整度，Plugin MCP | 高完整度，Plugin MCP | 可行 |
| 精确 `检查todo` 原始输入门 | 已实现 `input` | 完整可行，消息/Agent hooks | 完整可行，`UserPromptSubmit` | 完整可行，`UserPromptSubmit` | 不应承诺 |
| PreToolUse 防伪上下文注入 | Pi 内部工具上下文 | 原生 tool context | 可用 `PreToolUse updatedInput` | 可用 `PreToolUse updatedInput` | 不应承诺 |
| session + cwd | 已实现 | `sessionKey/sessionId/workspaceDir` | `session_id/cwd` | `session_id/turn_id/cwd` | roots 可用但 session 证明不足 |
| IM route / endpoint | tmuxbot adapter | 原生 channel/requester 最强 | CLI 默认无 IM route | CLI 默认无 IM route | 无 |
| settled/Stop 收口门 | `agent_settled` | `before_agent_finalize` + `agent_end` | `Stop` | `Stop` | 不应承诺 |
| 当前最终回复文本 | 已实现 | `lastAssistantMessage/messages` | `last_assistant_message` | `last_assistant_message` | 无 |
| 阻止早产停止并继续工作 | 已实现 | finalize `revise` | Stop `block` | Stop `block` | 无 |
| 持久 Overlay | 已实现 | 可做宿主 UI，但需单独设计 | 无 Pi Overlay 等价接口 | 无 Pi Overlay 等价接口 | 无 |
| `/todos` 等价只读 UI | 已实现 | 可注册 tool/command/UI | 可做 skill/command + MCP | 可做 skill/plugin + MCP | 工具文本 |
| 入站/出站附件 | tmuxbot | 原生 media/reply payload 最强 | 可读本地文件；无通用原 IM 上传保证 | 可读本地文件；无通用原 IM 上传保证 | 取决于宿主 |
| 后台定时唤醒 | 默认禁用 | 宿主 cron 可用但默认必须禁用 | monitors/cron 存在但默认必须禁用 | background hook 不启动新 turn | 不适用 |
| 插件版本隔离 | Pi Git checkout，忙碌升级需等待 | Gateway plugin restart | 版本 cache，`/reload-plugins` | plugin trust/restart/refresh | 进程独立 |

## 推荐深模块与 seam

### 1. Host-neutral Todo Engine

这是深模块：调用者只需要提供宿主事实，复杂的 Dida 同步、任务类型、优先级、时间门、生命周期、验收、身份门和并发规则都隐藏在实现中。

建议外部 interface 只保留四类入口：

```ts
interface TodoEngine {
  openSession(context: HostSessionContext): Promise<SessionSnapshot>;
  prepareTurn(input: HostTurnInput): Promise<TurnPreparation>;
  executeTool(call: AuthorizedToolCall): Promise<ToolResult>;
  finalizeTurn(input: HostTurnFinalization): Promise<FinalizationDecision>;
}
```

接口不暴露 Pi UI、Claude hook JSON、Codex config 或 OpenClaw hook event。各 adapter 负责把宿主事件翻译成这四类事实。

### 2. Dida Gateway seam

当前 `DidaGateway` 已经是真实 seam。把 `DidaCliGateway` 从 `pi.exec` 改为注入中立的 `ProcessRunner`：

```ts
interface ProcessRunner {
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
}
```

Pi Adapter 提供 Pi runner；其他 adapter 提供 Node `spawn` runner。Repository 不需要知道宿主。

### 3. Mutation Queue seam

`withFileMutationQueue` 是 Repository/Provisioning 对 Pi 的非领域依赖。应改成中立 `MutationQueue`，默认 Node adapter 与现有同宿主目录锁配合。Pi Adapter 可以继续调用旧能力，或在契约完全一致后切换。

**重要兼容要求**：如果不同 adapter 可能访问同一个 Dida project，新实现必须继续使用与 Pi 兼容的 host-lock key/path 协议，不能各锁各的。

### 4. Host Adapter

每个 adapter 独立负责：

- 原始用户输入；
- session/turn/run/cwd/route 事实；
- 工具注册和权限；
- Stop/finalize/agent-end 生命周期；
- UI、状态提示和文件交付；
- 安装、升级和 reload。

这些差异不应泄漏进 Todo Engine。

## Turn Grant：精确口令的跨进程授权

MCP Server 与宿主 Hook 通常是不同进程。仅在 Hook 内设置 Boolean 无法保护 MCP 工具；把授权写进 Skill 提示词也无法形成安全门。

建议定义一次性 **Turn Grant**：

```text
Host UserPromptSubmit/message_received
→ trim(prompt) === "检查todo"
→ 为 adapterId + sessionId + turnId/runId 签发短期一次性 grant
→ PreToolUse 为 dida-todo MCP call 注入可信 hostContext + grant
→ MCP Server 验证并消费 grant
→ todo_work list/switch/next/refresh 才可访问远端
→ turn finalize/session end/超时后清理
```

安全属性：

- grant 不由模型或用户参数直接声明；
- Claude/Codex 使用 `PreToolUse updatedInput` 注入，模型无需看到 token；
- OpenClaw 原生工具可直接从 tool context 获取 session/run，不必把 token暴露给模型；
- grant 绑定 `adapterId + sessionId + turnId/runId + cwd/binding`，不能跨 CLI、跨 session 或跨项目复用；
- mutation 工具不需要 queue grant，但仍需要可信 hostContext；
- grant 一次性消费并带短 TTL；
- 无 hooks、hooks 未获 trust、字段缺失或验证失败时 fail closed。

## 跨 adapter 项目与执行所有权

### 默认隔离

为了不影响已经验收的 Pi，其他 adapter 首版必须使用独立 binding/config namespace：

```text
Pi:        ~/.config/pi-dida-todo/config.json（保持不变）
OpenClaw:  adapter=openclaw
Claude:    adapter=claude-code
Codex:     adapter=codex
```

新 adapter 的自动 provisioning 默认包含 adapter identity，不得因为 cwd 相同就自动复用 Pi 的项目。推荐名称形态：

```text
[hostname][adapter][channel?] route-or-cwd
```

### 显式共享属于后续能力

如果用户明确要求多个 CLI 共享同一个 Dida project，必须先引入跨 adapter execution ownership：

- metadata owner 增加 `adapterId`；
- claim 必须绑定 occurrence + adapter + host + session；
- 同宿主共享现有锁协议；
- 其他 adapter 不得接管仍有活跃 claim 的工作；
- stale claim 的接管规则必须明确、可审计；
- 跨宿主仍受 Dida 缺少 CAS/ETag/幂等 key 限制。

在该协议完成前，**不允许自动共享 Pi 项目**。这是保护 Pi 现场数据的关键边界。

## 每个宿主的推荐实现

### OpenClaw：首选完整 adapter

推荐原生插件，而不是仅 MCP：

- `api.registerTool` 注册 namespaced 工具，例如 `dida_todo`、`dida_todo_work`；
- `message_received`/`before_agent_run` 识别精确口令和 host identity；
- `before_prompt_build` 注入完整队列；
- `before_tool_call` 强制可信 session/run 上下文；
- `before_agent_finalize` 重读远端，必要时请求 revise；
- `agent_end` 在成功 turn 后回填最终回复；
- `session_end/gateway_stop` 只做有界清理；
- channel media/reply payload 用于附件交付。

OpenClaw 自带 cron，但首版 adapter 必须保持当前产品决策：普通工作不后台扫描、不自动唤醒。将来如增加定时执行，应是独立、显式授权、限定任务/route 的 Scheduler。

### Claude Code：Plugin + MCP + command hooks

推荐：

- Plugin 捆绑 stdio MCP Server；
- `UserPromptSubmit` 签发 Turn Grant并注入队列上下文；
- `PreToolUse` 为 MCP 调用覆盖注入 hostContext/grant；
- `Stop` 使用 `last_assistant_message`，重读远端并决定 allow/block；
- `SessionStart/End` 负责恢复与清理；
- Skill 只说明工作流，不能承担权限门。

不能承诺 Pi Overlay。首版提供 MCP 文本结果、一个只读 status skill/command，以及 Dida 远端状态即可。

Claude Plugin 使用版本隔离 cache，适合与 Pi 安装目录完全分开；不要让 Claude Plugin 指向 Pi Git checkout。

### Codex CLI：Plugin + MCP + command hooks

推荐结构与 Claude 类似：

- Plugin 捆绑 MCP 与 `hooks/hooks.json`；
- `UserPromptSubmit` 使用原始 `prompt` 和 `turn_id` 签发 grant；
- `PreToolUse` 为 MCP 工具注入可信字段；
- `Stop` 使用 `last_assistant_message` 与 `stop_hook_active`；
- `SessionStart/End` 恢复和清理；
- 安装后 hooks 必须通过 Codex trust review。

Codex 官方说明部分 specialized/hosted tools 可绕过默认 tool hook path，所以安全门必须放在 dida-todo MCP Server 内再次验证，不能只依赖 PreToolUse。

不能承诺 Pi Overlay；可提供 plugin skill、MCP tool 文本输出和 Dida 状态。

## 工具命名

不要在其他宿主直接抢占泛化名称 `todo`：Claude/Codex/OpenClaw 可能已有内建 Task/Todo 能力。

建议：

```text
MCP server: dida-todo
Tools: dida_todo, dida_todo_work, dida_todo_setup
```

在 Claude/Codex 中最终工具名由 MCP namespace 自动前缀化；在 OpenClaw 使用明确 namespaced 原生 tool。Pi 保持现有 `todo`、`todo_work` 和 `/todos`，不做破坏性改名。

## 不应采用的方案

### 方案 A：直接让其他 CLI 执行当前 Pi Extension

拒绝原因：Pi 的 ExtensionAPI、TUI、session events、`agent_settled` 和 Package Loader 不是通用协议。

### 方案 B：只发布一个 Skill，让模型调用 dida CLI

拒绝原因：提示词不是权限门；无法可靠实现精确口令、一次性队列授权、并发锁、occurrence、唯一验收和最终回复回填。

### 方案 C：一个入口文件通过 if/else 判断当前宿主

拒绝原因：把四家生命周期和安装差异扩散进已验收 Pi 路径，降低 locality，任何新宿主变更都可能回归 Pi。

### 方案 D：所有 adapter 默认按 cwd 共享 Pi 的 Dida project

拒绝原因：当前 metadata owner 没有 adapter identity；同一工作可能被两个 CLI 同时 claim/finish。默认必须隔离。

### 方案 E：为了 OpenClaw/Claude 的 cron/monitor 恢复普通 Poller

拒绝原因：违反当前只有精确 `检查todo` 才扫描队列的产品不变量。定时执行必须作为后续独立、显式授权能力设计。

## 分阶段路线

### Phase 0：冻结 Pi 契约

- 保存 v0.6.13 的全部自动与真实测试作为 Pi Adapter contract suite；
- 记录现有工具 schema、错误文本、Overlay、精确口令、验收和 metadata 兼容性；
- 不改 Pi 安装和部署。

### Phase 1：抽取可测试的中立 seam

只做行为保持重构：

1. `ProcessRunner` 取代 `pi.exec`；
2. `MutationQueue` 取代 Repository/Provisioning 对 Pi 的直接导入；
3. 定义 HostSession/Turn/Finalization facts；
4. 建立 Turn Grant store；
5. 让原 Pi Adapter 继续使用原入口和 UI；
6. 所有 Pi contract tests、真实 Dida 测试必须无变化通过。

这一步不发布其他 adapter。

### Phase 2：OpenClaw 隔离原型

- 新目录/独立 package；
- 使用独立测试 Dida project 和 adapter namespace；
- 验证精确口令、mutation 不扫描、Stop/finalize、最终回复、附件和 Gateway restart；
- 不连接 Pi 的正式项目。

### Phase 3：Claude Code 隔离原型

- Plugin cache 内独立 package；
- 验证 Hook trust、MCP lifecycle、Turn Grant、Stop block、`last_assistant_message` 和 `/reload-plugins`；
- 不实现伪 Overlay。

### Phase 4：Codex 隔离原型

- Plugin marketplace + MCP + trusted hooks；
- 验证 specialized tool hook 旁路时 MCP Server 仍 fail closed；
- 验证 Stop continuation 与 session resume。

### Phase 5：可选共享项目

只有 adapter 隔离模式全部稳定后，才设计 schema v3 的 adapter-aware claim 和显式共享项目迁移；跨宿主继续不承诺 exactly-once。

## 发布与测试要求

每个 adapter 是独立发布单元：

```text
dida-todo-pi
@dida-todo/openclaw
@dida-todo/claude-code
@dida-todo/codex
@dida-todo/core（内部或共享依赖）
```

名称仅示意。不得让一个宿主的安装命令覆盖另一个宿主的 checkout/cache。

共同 contract tests 至少覆盖：

- Direct/Checklist；
- priority 0/1/3/5；
- 日期、时间、循环 occurrence；
- 精确口令与近似表达；
- mutation 不扫描；
- 追加 Item 撤销早期收口；
- 唯一验收和最终回复回填；
- 本人评论身份门；
- 同宿主多进程并发；
- adapter/session/turn grant 不串用；
- adapter 安装、reload、session resume；
- 不访问 Pi 正式 project 的隔离证明。

各 adapter 还需要宿主真实验收，不得只用 fake MCP client 宣称兼容。

## 最终建议

1. **产品上可行，值得做。**
2. **首选 OpenClaw 原生 adapter**，因为生命周期、route、附件和 settled finalization 最接近甚至覆盖 Pi 所需 seam。
3. 第二优先级是 Claude Code，第三是 Codex CLI；后二者共享 MCP + command hooks 的大量实现，但分发、trust 和 reload 仍需独立 adapter。
4. **Pi 端先冻结，不先重构。**中立 core 由新 adapter 原型倒逼形成，达到两 adapter 的真实 seam 后再让 Pi 选择性迁移。
5. 首版禁止跨 adapter 自动共享 Dida project；禁止恢复普通后台 Poller；禁止声称 Overlay parity。
