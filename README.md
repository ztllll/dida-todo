# dida-todo

[中文](#中文) · [English](#english)

> 让滴答清单成为人类与 Pi 共享的长期工作入口：人类随时记录，LLM 按需读取和执行，过程实时同步，完成后回到人类验收。

---

# 中文

## 项目简介

`dida-todo` 是一个面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的开源扩展。它保留熟悉的 `todo` 工具、`/todos` 命令和编辑器上方 Overlay，但将**滴答清单（Dida365）设为持久任务真源**。

你可以在手机或网页端随时把灵感、缺陷和需求写入一个固定滴答清单；设置低/中/高优先级后，空闲 Pi 会按轮询周期自动同步、领取并执行已到时间的工作，也可完整输入固定口令 `检查todo` 立即触发。口述添加、追加、修改、完成或删除 Todo 只执行对应操作，不会顺手扫描其他工作。一次用户消息中的相关要求归入一个顶层工作，全部完成后只生成一条带提醒的**待验收 Todo**。

## 功能亮点

### 1. 滴答即共享工作入口

```text
人类在滴答记录任务
→ 对 Pi 完整输入“检查todo”
→ LLM 读取并执行
→ Checklist 和评论持续回写滴答
```

- 用户在滴答创建的任务未领取前保持原始形态；一旦 LLM 正式领取执行，就统一使用至少一个可见 Checklist Item 表达执行计划，哪怕只有一步。原始一级任务会原地提升，不会新建重复顶层任务。
- LLM 根据顶层标题、描述、正文和已有 Checklist 把自然语言整理成更精确的可执行步骤并同步回滴答；Pi TUI 与滴答始终展示同一组进度项。
- 用户原始 Checklist Item 的文本和结构受保护，Pi 只能推进状态和写入 `metadata.resolution`，不能改名或删除；LLM 可以追加自己的精确步骤。Pi 自建 Direct Work 仍可使用内部 Execution Steps。

### 2. 自然语言优先

Todo 只用于需要持久追踪的用户工作，不是 LLM 的通用思考清单。普通聊天、简单问答、一次性联网查询、只读检查、短命令、翻译、润色和总结均不得创建 Todo；内部调用多个工具也不构成建表理由。允许建立顶层工作仅限：用户明确要求记录/追踪、多步骤代码/配置/服务实施、跨轮或跨会话恢复、后台执行后验收。每次 `todo create` 都必须携带由当前用户请求授权的 `trackingReason`；追加当前工作必须使用 `current_work_step`，并把理由写入步骤 metadata 供审计。

用户公开界面只保留原 Todo 体验：

```text
/todos
Ctrl+Shift+T  # 折叠/展开 Overlay
```

主动执行整个队列只能完整输入：

```text
检查todo
```

其他自然语言按实际意图处理，例如“追加 Todo：补充回归测试”“修改当前 Todo 的详细要求”“把数据库升级加入 Todo 并持续跟踪”。`检查 todo`、`帮我检查todo`、`查看待办`、`同步 Todo` 等近似表达均不会触发整队列扫描。

普通问答直接回答，不需要用户先关闭或绕过 Todo。

内部 `todo_work` 仅供 LLM 管理顶层工作队列，用户无需学习一组新的 slash commands。

### 3. 双向状态同步

- `todo create/update/delete` 会写入滴答 Checklist。
- 滴答侧的标题修改和完成状态会同步回 Pi。
- Pi Overlay 在当前工作对话内持续展示完整 Checklist；已完成步骤保留到新工作取代它或会话关闭，滴答中的完成历史不会删除。
- 滴答 Checklist 没有原生“进行中”，该状态由受管元数据保存；滴答侧仍显示未完成。

### 4. 多工作任务与调度

- 一个项目或 tmux 工作目标固定绑定一个滴答清单。
- 顶层 Task 表示一次完整用户请求批次。一条消息中的多个相关要求，以及同一目标的后续追加，归入同一个顶层工作并统一验收。
- 用户在滴答创建的 Direct Work 被领取后，LLM 必须先生成至少一个 `subject`，Repository 会原地提升为 Checklist；顶层标题、描述和正文继续承载完整目标与用户原始语义。
- Pi 新建 Direct Work 仍使用 LLM 整理后的简洁任务名和内部 Execution Steps；Pi 新建 Checklist Work 使用整组目标摘要 `workTitle`，具体 Item 使用 `subject`，二者不得相同。
- LLM 可遍历全部未完成顶层任务，而不是只处理第一项；大型 Checklist Work 在同一顶层持续追加进度，不按阶段拆成多个顶层 Todo。
- LLM 新建顶层工作必须根据实际紧急性和影响设置 `workPriority: low | medium | high`，映射为 1/3/5；priority=0 只保留给用户草稿。历史 Pi 自建 priority=0 工作同步时迁移为 low=1。
- 顶层工作按优先级高→中→低执行；同优先级严格保持滴答清单返回顺序，并保留开始/截止时间、时区、全天、提醒和重复字段。
- 循环任务可以在同步时被发现，但发现不等于执行。priority 只排序已经通过时间门的工作：非全天任务必须处于任务时区下的计划当天且当前时间不早于 `startDate`（没有时回退 `dueDate`）；全天任务只检查计划日期是否为今天。未来 occurrence 会被过滤，过期 occurrence 不自动补跑。

#### 循环任务执行时机

以每天 10:00 的非全天循环任务为例：

| 执行 `检查todo` 的时间 | 能同步看到任务 | 是否进入执行队列 |
| --- | --- | --- |
| 前一天，滴答已推进到明天 10:00 | 是 | 否 |
| 当天 09:59 | 是 | 否 |
| 当天 10:00 或之后 | 是 | 是 |
| 第二天才检查遗漏的 occurrence | 是 | 否，不自动补跑 |

提前轮询不会为单项任务注册 10:00 timer；Poller 会在后续周期重新同步，因此实际领取时间是“到达计划时间后的下一次空闲轮询”，也可在到点后输入 `检查todo` 立即执行。如果任务本意为 10:00，必须设置成非全天，否则当天首次轮询就可能执行。完整边界见 [`docs/operations/recurring-scheduling-and-live-upgrades.md`](docs/operations/recurring-scheduling-and-live-upgrades.md)。

### 5. 强制人类验收闭环

验收不是靠 LLM“记得做”，而是 `WorkFinalizer` 自动触发的完成不变量：

```text
Pi 自建 Direct Work 的全部 Execution Steps 完成，或 Checklist Work 明确声明整个顶层目标完成
→ 等待本轮 Agent settled（无工具、重试、压缩或 follow-up 继续执行）
→ 重新确认仍无未完成步骤且满足对应顶层完成语义
→ 根据每一步 resolution 生成完成报告
→ 幂等创建/复用 🧑‍🔬 待验收 Todo
→ 设置完成后 +3/+6 分钟两次提醒
→ 补齐人类反馈评论入口
→ 验收 Todo 与评论成功后，才完成原工作并 detach Runtime
```

启动、`/todos` 和精确口令同步还会修复符合完成语义的历史夹生任务；验收失败时源任务保持未完成并明确报错。任何新 Item 追加到 `ready_for_acceptance` 工作时都会撤销旧收口许可，全部完成后必须重新显式收口，避免阶段性验收。重复任务按 occurrence 隔离验收。`todo_work finish_current` 只保留为幂等恢复入口，不再承担正确性。

- 人类验收通过：在滴答完成验收 Todo，闭环结束。
- 需要调整：保持验收 Todo 未完成，并使用当前滴答 OAuth 账号直接评论。Repository 会核对评论 `userId`：本人评论自动创建独立返工工作、关闭旧验收并继续处理；其他账号或缺失身份的评论完全静默忽略。任务描述区继续承载报告和说明，不作为控制通道；已完成源 Checklist 不回滚。
- “尚未点击完成”只代表尚未闭环，不会被自动判定为实现失败。

### 6. 稳定性与并发边界

- `WorkMetadata v2` 显式记录来源、生命周期、当前 occurrence 与 finalization；priority 仅表达调度优先级。
- priority-0 统一视为用户草稿，只同步不执行；Pi 自建工作必须是 low/medium/high，历史错误数据会在锁内重读后迁移为 low。
- 同一宿主的 Checklist 更新、优先级迁移、验收、provisioning 与配置写入使用真实跨进程锁，临界区内重新读取远端；崩溃遗留锁会回收。
- Poller 默认每 10 分钟在 Pi 空闲且没有 pending message 时同步；只有 priority>0、未完成且通过日期/时间门的普通工作才唤醒 LLM。priority-0 草稿和仅待验收队列保持静默。
- 已完成工作拒绝 Checklist mutation；完整 Items 写回会保留远端未知字段、日期与时区。
- 跨宿主没有公开 Dida CAS/ETag/幂等创建能力时不承诺 strong consistency 或 exactly-once。

### 7. 显式队列检查

扩展通过两条可信入口签发本轮短期队列授权：用户完整输入 `检查todo`，或空闲 Poller 发现 priority>0 且已到期的普通工作。LLM 自己、普通 Todo mutation 和近似口令都不能签发授权；`todo_work list/switch/next/refresh` 在无授权时会在远端访问前拒绝。`/todos` 仍是显式只读刷新命令，添加或修改当前 Todo 也只操作当前工作。

### 8. 链接与文件交付

- 任务 `content`、`desc` 和 Checklist 文本中的 HTTPS 链接会随完整任务载荷交给 Agent，并按不可信外部资源处理；图片直链也只作为 URL。官方 API/CLI 能完整读回普通评论链接，但当前 dida-todo 不把普通工作评论注入执行载荷；待验收评论仅按既有身份门用于返工。
- 官方 Task/Comment schema 没有附件字段，也没有文件上传、下载或图片评论 endpoint；因此不承诺读取滴答原生附件，也不通过私有 API 上传结果文件。
- 经 tmuxbot 使用时，Telegram/飞书图片和文件可以下载到受控本地路径交给 Agent；完成后的真实本地图片/文件可由最终回复引用，并上传回同一精确 IM endpoint。

### 9. 多 CLI 适配边界

当前正式实现和发布单元只支持 Pi。经 OpenClaw、Claude Code 与 Codex CLI 第一方接口核验，dida-todo 可以扩展到这些宿主，但不会把其他 CLI 的生命周期分支塞进已验收的 Pi 入口。

推荐架构是一个宿主中立 Todo Engine 加四个独立 Host Adapter/Package。OpenClaw 原生插件最适合首个完整适配；Claude Code 和 Codex CLI 可使用 Plugin + MCP + `UserPromptSubmit`/`Stop` hooks 实现高完整度适配。只有 MCP、没有可信宿主 hooks 时属于降级模式，不能保证精确 `检查todo`、settled 收口或最终回复回填。

其他 adapter 首版必须使用独立 binding/project namespace，不得因为 cwd 相同就自动接管 Pi 的 Dida project；Pi 工具名、Overlay、配置和发布单元保持不变。本研究尚未实现或部署其他 CLI adapter。后续 LLM/开发者请从根部 [`DEVELOPMENT.md`](DEVELOPMENT.md) 开始，并按[完整开发手册](docs/development/multi-cli-adapter-development-guide.md)、[多 CLI 可行性研究](docs/research/2026-08-13-multi-cli-adapter-feasibility.md)与 [ADR-0001](docs/adr/0001-host-neutral-core-with-isolated-cli-adapters.md)执行。

### 10. 会话独立与永久历史

- `/new`、会话切换、compact 或 detach 不删除滴答历史。
- 滴答是唯一任务真源；Pi Runtime 只是当前展示与活动工作缓存。
- `todo clear` 仅解除当前工作绑定，不删除远端数据。

## 数据模型

```text
固定滴答清单（一个项目/工作目标）
├── 顶层工作任务（一次完整工作）
│   ├── Checklist Item（Pi Todo）
│   ├── Checklist Item（Pi Todo）
│   └── Checklist Item（Pi Todo）
└── 🧑‍🔬 待验收任务（完成报告 + 提醒 + 人类反馈入口）
```

## 安装

### 最简流程：全局安装 + 登录

```bash
pi install git:github.com/ztllll/dida-todo@v0.6.17
```

新开任意 Pi 会话，直接告诉 LLM：

```text
登录滴答
```

GitHub 安装会自动安装运行依赖 `@suibiji/dida-cli`；用户不需要另装全局 `dida`，也不需要寻找 Git 包目录。内部 `dida_todo_setup login` 会调用包内 CLI 打开浏览器 OAuth。首次浏览器授权是唯一必须由用户完成的交互。

登录成功后，扩展自动完成：

1. 首次自动 provisioning 生成跨环境名称：tmuxbot route 可精确识别时使用 `[hostname][channel] route-name`；否则使用 `[hostname] tmux-session-or-cwd`，不猜 IM 通道；
2. route/channel 只通过 tmuxbot canonical Admin inventory 按精确 tmux target 读取；不把 credential、chat_id、thread_id 或 token 写入滴答；
3. 唯一同名清单存在则复用，不存在则创建 TASK/list 清单；
4. 自动持久化精确 tmux target；cwd alias 仅在未被另一 route 占用或指向同一 project 时写入，避免共享 cwd 的 Telegram/飞书 route 相互覆盖；
5. 当前会话立即同步并启用，无需填写 projectId；
6. 空清单明确显示“滴答 Todo 已就绪”，直接口述第一项任务即可；首个 Todo 自动建立顶层工作与 Checklist。

完成“登录滴答”的当前会话无需 `/reload` 或第二次配置。新启动的 Pi 会话会自动加载并复用登录状态。只有当某个 Pi 进程已经运行、用户再从外部安装或升级包时，该存量进程受 Pi Loader 生命周期限制需要执行一次 `/reload`；尚未加载的扩展无法自行让旧进程热更新。

存在多个同名清单时扩展拒绝猜测。用户可直接口述“把当前项目绑定到清单 X / projectId Y”，由内部 setup 工具改绑。设置 `autoProvisionProject: false` 可关闭默认自动 provisioning。

手工登录回退：进入 dida-todo Git 安装目录运行 `./node_modules/.bin/dida auth login`。

升级：

```bash
pi install git:github.com/ztllll/dida-todo@v0.6.17
# 或安装 main：pi install git:github.com/ztllll/dida-todo
```

**不要在使用 dida-todo 的 Pi 进程正执行任务时直接安装。**Git Package 安装会 reset/clean 共享 checkout 并重新安装依赖，但已运行进程不会自动替换内存中的扩展 Runtime，可能形成“旧 Runtime + 新磁盘文件/CLI/依赖”的混合状态。安全流程是：等待所有相关 pane 完成当前原子任务并 idle → 安装固定版本 → 对每个存量 Pi 执行 `/reload` 或启动新进程 → 再做 `/todos`/隔离 smoke test。安装本身通常不会主动杀死旧 Pi，但忙碌状态下不能保证后续工具调用不受影响。详见[运维边界](docs/operations/recurring-scheduling-and-live-upgrades.md)。

本项目只以 GitHub 为正式发布渠道，不发布 npm 包。

### 冲突迁移

必须禁用 `@juicesharp/rpiv-todo` 或其他同时注册以下接口的扩展：

```text
todo 工具
/todos 命令
```

Pi Loader 会把重复注册的工具显示为扩展诊断；使用前仍必须禁用冲突提供者，避免加载顺序决定实际接口。它可以与 `@narumitw/pi-statusline`、`pi-updater` 和纯主题包共存。

## 高级配置

创建：

```text
~/.config/pi-dida-todo/config.json
```

示例：

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "autoResumeSingle": true,
  "autoProvisionProject": true,
  "bindings": [
    {
      "key": "tmux:my-project:0.0",
      "cwd": "/absolute/path/to/project",
      "projectId": "DIDA_PROJECT_ID",
      "label": "my-project"
    },
    {
      "key": "cwd:/absolute/path/to/project",
      "projectId": "DIDA_PROJECT_ID",
      "label": "my-project"
    }
  ]
}
```

默认自动创建/复用和绑定；手工 `bindings` 仅用于覆盖默认行为。绑定优先级：精确 tmux target → 精确 cwd。多个同名清单时不会猜测。

`pollIntervalMinutes` 默认是 **10 分钟**，可设置为 `1–1440`。Poller 仅在 Pi 空闲且没有 pending message 时同步；priority>0 的工作还必须通过任务 `timeZone`、日期和时间门，未来、过期或尚未到点的 occurrence 静默跳过，无日期任务按优先级执行。完整输入 `检查todo` 可立即触发同样的队列检查。`didaCommand` 是可选高级覆盖；默认解析本项目依赖中的 `@suibiji/dida-cli`。

## 使用示例

在滴答创建：

```text
实现全文搜索
├── 分析现有查询接口
├── 实现索引与排序
└── 添加测试
```

然后在 Pi 完整输入：

```text
检查todo
```

也可以在空清单中直接口述“添加 Todo：修复登录流程”。`/todos` 与 `todo list` 会把空清单显示为“滴答 Todo 已就绪”，而不是报错；第一项 Todo 会自动创建对应顶层工作。

扩展默认每 10 分钟在空闲状态主动检查并领取 priority>0 且已到期的工作；完整输入 `检查todo` 可立即同步并执行队列。没有 Checklist 的直接任务会由 LLM 根据任务名、描述和正文创建内部执行步骤，已有 Checklist 的分级任务会同时读取汇总标题、描述、正文与全部子任务。

执行期间你可以在滴答看到 Checklist 完成变化和 Pi 评论。工作结束后，会出现：

```text
🧑‍🔬 待验收：实现全文搜索
```

验收创建采用两阶段：最后一个 Checklist 完成后先等待 Agent settled，确认本轮不会继续调用工具、重试、压缩或处理 follow-up，且远端仍无未完成步骤，再创建安全占位报告并完成源任务；随后把用户实际看到的最终回复原样回填到待验收 `desc` 与正文，并据此生成结果型标题。最终内容同时保留原任务关联、提醒和人类操作说明。

## 诚实的限制

1. Dida 官方 OpenAPI 不公开原生附件上传/下载；链接可以处理，图片和文件应通过当前 IM 通道交付。
2. 滴答 Checklist 没有原生 `in_progress`，因此进行中状态主要在 Pi Overlay 可见。
3. Dida CLI 更新需要发送完整 Items；项目已做进程内和文件队列串行化，但跨主机并发、etag 冲突、限流和长期无人值守仍需更多验证。
4. 当前重点支持滴答清单，不宣称兼容 TickTick 国际版。
5. 自动接管会修改目标任务内容并加入受管元数据；建议使用专用清单并先在测试项目验收。
6. `todo` 和 `/todos` 是兼容接口，因此不能与 `rpiv-todo` 同时启用。

## 参考项目与致谢

本项目不是从零凭空设计，主要参考并感谢：

- [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)：Todo 工具 schema、三态工作流、`/todos`、Overlay、依赖与 tombstone 等交互设计。本项目重新实现了滴答后端、同步、顶层工作队列和人类验收；没有复制其会话 JSONL 持久化方案。
- [`@suibiji/dida-cli`](https://www.npmjs.com/package/@suibiji/dida-cli)：滴答 OAuth 与任务/清单/评论 CLI Adapter，本项目通过子进程调用其公开 CLI。
- [Pi Coding Agent](https://github.com/earendil-works/pi)：Extension API、工具、命令、TUI、生命周期和 Pi Package 机制。
- 滴答清单：提供最终任务、Checklist、优先级、时间、提醒和评论载体。本项目与滴答清单官方无隶属、背书或合作关系。

所有第三方项目归其各自作者所有，请同时遵守其许可证和服务条款。

## 开发过程

这个项目采用真实滴答清单驱动的迭代方式开发：

1. 先只读盘点 Dida CLI 和 `rpiv-todo` 行为。
2. 建立“固定清单 → 顶层工作 → Checklist 步骤”的领域模型。
3. 用假 CLI 和 Repository seam 做 TDD。
4. 在专用清单真实验证创建、进行中、完成、重启恢复和手工 Item 导入。
5. 根据真实使用反馈增加自动接管、多工作队列、优先级/时间、评论回写和提醒。
6. 通过多轮人类可视化观察，验证 Pi → 滴答和滴答 → Pi 双向同步。
7. 将“完成后必须创建验收 Todo”下沉为 Repository 不变量。
8. 精简用户界面，只保留 `/todos`，其余通过自然语言和内部工具完成。

当前 `v0.6.17` 已通过 39 个测试文件、178 项默认自动测试（另有 1 项 opt-in 真实 Dida 验收），以及 TypeScript、官方 Extension Loader、包内容与凭据扫描。真实门已验证两次 reminders、评论 userId 身份门、本人评论自动返工、最终回复回填及每日重复实例推进；跨宿主仍不承诺强一致，因为公开 Dida 接口尚未确认 CAS/ETag 或幂等创建 key。

## 开发成员

- **发起人 / 产品设计 / 人类验收：Ztllll**（[@ztllll](https://github.com/ztllll)）  
  提出“滴答作为人类与 LLM 共享任务入口”的目标，定义自然语言工作流、人类验收闭环，并在真实滴答与 Pi TUI 中持续观察、反馈和决定产品方向。
- **实现协作：OpenAI GPT-5.6（Pi Coding Agent 会话）**  
  在 Ztllll 的指导和逐轮验收下参与需求拆解、代码实现、测试、文档与发布准备。AI 不是独立维护者，也不拥有仓库或发布权限；所有外部发布均由人类明确授权。
- **维护者：Ztllll**  
  当前代码审查、发布决策、Issue/PR 管理与项目责任归人类维护者所有。

## 开发与贡献

```bash
git clone https://github.com/ztllll/dida-todo.git
cd dida-todo
npm ci
npm run check
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 发布渠道

- GitHub Repository: https://github.com/ztllll/dida-todo
- GitHub Releases: https://github.com/ztllll/dida-todo/releases
- npm：不发布

## License

MIT。第三方依赖与参考项目遵循其各自许可证。

---

# English

## Overview

`dida-todo` is an open-source extension for [Pi Coding Agent](https://github.com/earendil-works/pi). It preserves the familiar `todo` tool, `/todos` command, and live Overlay while using **Dida365 as the durable source of truth**.

Capture ideas, bugs, and feature requests in Dida365 from your phone or browser. The whole queue is synchronized and executed only when the user's trimmed input is exactly `检查todo`. Add, append, update, complete, and delete requests affect only their intended work. Related requirements from one user message form one top-level work and one eventual **human acceptance Todo**.

## Highlights

- **Dida365 as a shared inbox:** humans capture work; the LLM reads and executes it.
- **Natural-language-first UX:** users keep `/todos` and the Overlay; top-level work management stays internal.
- **Complete task semantics:** user-created Dida tasks keep their original shape until claimed, then formal execution uses at least one visible Checklist Item—even for a one-step plan. Pi-created Direct work may keep internal execution steps; Pi-created Checklist work uses an aggregate title distinct from concrete Items.
- **Batched acceptance:** related clauses in one user request stay in one top-level work and produce one final response and one acceptance. Appending a new Item revokes any stale ready-for-acceptance state.
- **Priority-driven automatic queue:** while Pi is idle, the poller synchronizes every 10 minutes by default and wakes the LLM only for due, unfinished work with priority 1/3/5. Exact `检查todo` triggers the same queue check immediately; ordinary mutations and near-match phrases never scan unrelated work.
- **Recurring time gate:** synchronization may observe a future occurrence, but priority cannot bypass its schedule. Timed work runs only on its task-local day at or after `startDate` (falling back to `dueDate`); all-day work uses the calendar-date gate. Reaching the time does not wake Pi—the next exact queue check is required.
- **Mandatory priority:** every Pi-created top-level work must choose low/medium/high (1/3/5). Priority 0 is reserved for user drafts; historical Pi priority-0 work migrates to low under a same-host lock.
- **Durable history:** clearing or replacing a Pi session does not delete remote work.
- **Mandatory human acceptance:** `WorkFinalizer` prevents source completion until a pending acceptance Todo, placeholder report, and feedback comment exist. Once the agent settles, the exact user-visible final response replaces the placeholder in the acceptance description/body and drives a result-oriented title.
- **Identity-gated feedback loop:** keep acceptance open and comment with the current Dida OAuth account. The Repository matches the comment `userId` against the acceptance system-comment author, atomically creates a separate rework, and closes the superseded acceptance. Other or missing identities are silently ignored; descriptions remain non-control data.
- **Links and files:** HTTPS links in task text round-trip and are treated as untrusted external resources. Dida's public OpenAPI has no native attachment upload/download surface; tmuxbot can instead deliver incoming and outgoing files through the exact Telegram/Feishu endpoint.
- **Same-host resilience:** metadata v2 tracks origin/lifecycle/occurrence; real cross-process locks serialize mutation, priority migration, finalization, provisioning, and config writes. Cross-host strong consistency is not claimed without a Dida CAS/ETag/idempotency API.
- **Multi-CLI feasibility, not current support:** first-party interfaces show that OpenClaw, Claude Code, and Codex CLI can host dedicated adapters. The planned shape is one host-neutral Todo Engine plus isolated packages; MCP-only integration is degraded and cannot claim exact-input or settled-finalization parity. No non-Pi adapter is implemented or deployed yet. Future implementers should start with [`DEVELOPMENT.md`](DEVELOPMENT.md) and the [executable adapter guide](docs/development/multi-cli-adapter-development-guide.md).

## Model

```text
One fixed Dida365 project per local project / tmux target
├── Top-level work task
│   └── Checklist items (Pi Todos)
└── Human acceptance task (report + reminder + feedback entry point)
```

## Install

```bash
pi install git:github.com/ztllll/dida-todo@v0.6.17
```

In any new Pi session, tell the LLM:

```text
Log in to Dida365
```

The Git package automatically installs `@suibiji/dida-cli`; no global `dida` command is required. The internal `dida_todo_setup login` tool opens browser OAuth through the bundled CLI. Browser authorization is the only required manual step.

After login, dida-todo automatically derives a project name from the tmux session (or cwd basename), reuses the unique same-name project or creates a TASK/list project, persists exact tmux and cwd bindings, and activates the current session. An empty project reports **“Dida Todo is ready”** instead of failing; the first Todo automatically creates its top-level work task and Checklist. Users never need to find a projectId. Ask the LLM to rebind by exact name or projectId when needed. Duplicate names fail safely instead of being guessed.

The session that completes `dida_todo_setup login` is ready immediately—no `/reload` or second setup step. New Pi processes load the installed package automatically. Only Pi processes that were already running before an external install or upgrade need one `/reload`, because an extension that has not been loaded cannot hot-reload its host process by itself.

Do not install a new Git package ref while a Pi process using dida-todo is actively executing work. Installation resets/cleans the shared checkout and reinstalls dependencies while the existing process retains its old in-memory Runtime, creating an unsupported mixed state. Wait for all relevant processes to become idle, install the pinned ref, then `/reload` them or start new processes. See the [operations guide](docs/operations/recurring-scheduling-and-live-upgrades.md).

Set `autoProvisionProject: false` to opt out. GitHub is the only release channel; this project is not published to npm.

## Advanced configuration

Manual login fallback: run `./node_modules/.bin/dida auth login` from the Git package directory.

Create `~/.config/pi-dida-todo/config.json`:

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "autoResumeSingle": true,
  "autoProvisionProject": true,
  "bindings": [
    {
      "key": "tmux:my-project:0.0",
      "cwd": "/absolute/path/to/project",
      "projectId": "DIDA_PROJECT_ID",
      "label": "my-project"
    },
    {
      "key": "cwd:/absolute/path/to/project",
      "projectId": "DIDA_PROJECT_ID",
      "label": "my-project"
    }
  ]
}
```

Exact tmux target matching takes precedence over exact cwd matching. By default, an unbound session reuses the unique same-name project or creates one; it never guesses between duplicate names. Set `autoProvisionProject: false` for fully explicit bindings. `pollIntervalMinutes` defaults to 10 and accepts 1–1440. Automatic and exact `检查todo` execution both respect priority and task-local date/time scheduling. Priority 0 is a user draft; Pi-created work is always 1/3/5, and historical Pi priority-0 work is migrated to low.

## Usage

Public UI:

```text
/todos
Ctrl+Shift+T
```

Queue execution uses one exact phrase:

```text
检查todo
```

Other natural-language requests add, append, update, complete, or delete only the requested Todo. Near matches such as `检查 todo`, `Check Todo`, or “show my tasks” do not scan the queue.

An empty Dida project is a ready state, not an error: `/todos` and `todo list` report readiness, and the first Todo bootstraps the top-level work automatically.

While Pi is idle and has no pending messages, the poller synchronizes every 10 minutes by default and automatically claims due work with priority 1/3/5. Exact `检查todo` synchronizes immediately. A user-created Dida task keeps its original shape until claimed; formal execution then requires at least one visible Checklist Item, even for a one-step plan. The LLM derives precise Items from the top-level title, description, body, and existing Checklist while preserving user-authored Item text.

Internal tools:

- `todo`: Checklist steps in the current work.
- `todo_work`: internal top-level synchronization, switching, queue progression, and completion.

## Human acceptance invariant

```text
Last Checklist item completes
→ build a report from the original description/body and per-step resolutions
→ create or reuse a pending human-acceptance Todo
→ schedule exactly two reminders at completion +3 and +6 minutes
→ ensure the human feedback comment exists
→ only then complete the source work and detach the Runtime

Acceptance comments are identity-gated inside the Repository. A comment whose `userId` matches the acceptance system-comment author is atomically converted into a separate rework and the superseded acceptance is closed. Other or missing identities are silently ignored. The completed source Checklist is never reopened, and the rework runs a fresh acceptance cycle.
```

Pi-created Direct work finalizes only after all execution steps settle. User-created Dida work is promoted to Checklist when the LLM adds its first execution step. Checklist work requires explicit whole-objective completion; adding any Item after an early finish request resets the lifecycle to claimed and requires a fresh `finish_current`. Startup, `/todos`, and queue sync repair only work that satisfies its completion semantics. Acceptance failures leave the source task open and are reported explicitly. Recurring tasks isolate acceptance by occurrence, and `finish_current` remains only as an idempotent recovery action.

## Honest limitations

1. Dida365's public OpenAPI has no native attachment upload/download endpoints. Use HTTPS links or the active IM transport for images and files.
2. Dida365 Checklist items have no native `in_progress` state; that state is primarily visible in the Pi Overlay.
3. Cross-host concurrency, etag conflicts, rate limits, token expiry, and long unattended runs need more field testing.
4. The current scope targets Dida365 and does not claim TickTick International compatibility.
5. Adoption writes managed metadata into the target task; use a dedicated project and test first.
6. It cannot coexist with `rpiv-todo` because both intentionally expose `todo` and `/todos`.
7. The current release supports Pi only. OpenClaw, Claude Code, and Codex CLI adapter support is a researched architecture, not a shipped feature; see the [multi-CLI feasibility report](docs/research/2026-08-13-multi-cli-adapter-feasibility.md).

## References and acknowledgements

- [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo): inspiration for the Todo schema, three-state workflow, `/todos`, Overlay, dependencies, and tombstones. `dida-todo` reimplements persistence, synchronization, top-level work, and acceptance around Dida365.
- [`@suibiji/dida-cli`](https://www.npmjs.com/package/@suibiji/dida-cli): public CLI used for Dida365 OAuth, projects, tasks, Checklists, reminders, and comments.
- [Pi Coding Agent](https://github.com/earendil-works/pi): Extension API, tools, TUI, lifecycle, and package system.
- Dida365: remote task platform. This project is not affiliated with or endorsed by Dida365.

Third-party projects remain owned by their respective authors and retain their own licenses and terms.

## Development story

The project was developed through a real Dida365-driven feedback loop: read-only inventory, domain modelling, fake-CLI TDD, real project acceptance, manual Checklist adoption, explicit multi-work execution, scheduling and comments, long-running visual observation, mandatory human acceptance, zero-configuration project provisioning, and UX simplification. Release `v0.6.17` passed 178 default automated tests across 39 test files plus one opt-in isolated real-Dida gate, TypeScript, the official Extension Loader, package-content inspection, and credential scanning.

## Team

- **Initiator, product design, and human acceptance:** Ztllll ([@ztllll](https://github.com/ztllll)). Defined the shared Dida365/LLM workflow, reviewed real behavior, and owns product and release decisions.
- **Implementation collaborator:** OpenAI GPT-5.6 in a Pi Coding Agent session, working under Ztllll’s direction and iterative acceptance. The AI is not an independent maintainer and holds no repository or release authority.
- **Maintainer:** Ztllll. Human maintainers own review, releases, Issues, PRs, and project responsibility.

## Development

```bash
git clone https://github.com/ztllll/dida-todo.git
cd dida-todo
npm ci
npm run check
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before contributing. Multi-CLI adapter work must also follow [DEVELOPMENT.md](DEVELOPMENT.md) and the [adapter development guide](docs/development/multi-cli-adapter-development-guide.md).

## Releases

- Repository: https://github.com/ztllll/dida-todo
- Releases: https://github.com/ztllll/dida-todo/releases
- npm: not published

## License

MIT. Third-party dependencies and referenced projects retain their respective licenses.
