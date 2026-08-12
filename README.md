# dida-todo

[中文](#中文) · [English](#english)

> 让滴答清单成为人类与 Pi 共享的长期工作入口：人类随时记录，LLM 按需读取和执行，过程实时同步，完成后回到人类验收。

---

# 中文

## 项目简介

`dida-todo` 是一个面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的开源扩展。它保留熟悉的 `todo` 工具、`/todos` 命令和编辑器上方 Overlay，但将**滴答清单（Dida365）设为持久任务真源**。

你可以在手机或网页端随时把灵感、缺陷和需求写入一个固定滴答清单；之后只需对 Pi 说“检查 Todo”，LLM 就会同步清单、接管工作、执行 Checklist、更新状态，并在工作结束时生成一个带提醒的**待验收 Todo**。你不需要一直盯着 TUI，也不会因为清空 Pi 会话而丢失任务历史。

## 功能亮点

### 1. 滴答即共享工作入口

```text
人类在滴答记录任务
→ 对 Pi 说“检查 Todo”
→ LLM 读取并执行
→ Checklist 和评论持续回写滴答
```

- 支持两种滴答工作形态：没有 Checklist 的直接任务，以及带可勾选子任务的分级任务。同步与执行始终把顶层标题、描述、正文和 Checklist 作为一个整体读取；直接任务由 LLM 根据全部顶层内容拆分步骤，分级任务也不会只执行子任务标题。
- 支持用户在执行过程中新增、改名或完成 Checklist Item。
- Pi 刷新后会导入这些变化，并保留稳定的内部 Todo ID。

### 2. 自然语言优先

用户公开界面只保留原 Todo 体验：

```text
/todos
Ctrl+Shift+T  # 折叠/展开 Overlay
```

日常直接说：

```text
检查 Todo
处理高优先级任务
继续上次工作
看看待验收报告
```

内部 `todo_work` 仅供 LLM 管理顶层工作队列，用户无需学习一组新的 slash commands。

### 3. 双向状态同步

- `todo create/update/delete` 会写入滴答 Checklist。
- 滴答侧的标题修改和完成状态会同步回 Pi。
- Pi Overlay 在当前工作对话内持续展示完整 Checklist；已完成步骤保留到新工作取代它或会话关闭，滴答中的完成历史不会删除。
- 滴答 Checklist 没有原生“进行中”，该状态由受管元数据保存；滴答侧仍显示未完成。

### 4. 多工作任务与调度

- 一个项目或 tmux 工作目标固定绑定一个滴答清单。
- 顶层 Task 表示一次完整工作，Checklist Items 表示执行步骤。
- LLM 可遍历全部未完成顶层任务，而不是只处理第一项。
- 读取并保留优先级、开始/截止时间、时区、全天、提醒和重复字段。

### 5. 强制人类验收闭环

验收不是靠 LLM“记得做”，而是 `WorkFinalizer` 自动触发的完成不变量：

```text
最后一个 Checklist 完成
→ 根据每一步 resolution 生成完成报告
→ 幂等创建/复用 🧑‍🔬 待验收 Todo
→ 设置默认两分钟后的提醒，并在准时及其后 2/4/6/8 分钟持续催办
→ 补齐人类反馈评论入口
→ 验收 Todo 与评论成功后，才完成原工作并 detach Runtime
```

启动、`/todos`、自然语言同步和轮询还会自动修复“Checklist 全完成但顶层未完成”的历史夹生任务；验收失败时源任务保持未完成并明确报错。重复任务按 occurrence 隔离验收。`todo_work finish_current` 只保留为幂等恢复入口，不再承担正确性。

- 人类验收通过：在滴答完成验收 Todo，闭环结束。
- 需要调整：保持验收 Todo 未完成并评论；下次“检查 Todo”时，LLM 会读取反馈并先询问，再决定是否返工。
- “尚未点击完成”只代表尚未闭环，不会被自动判定为实现失败。

### 6. 稳定性与并发边界

- `WorkMetadata v2` 显式记录来源、生命周期、当前 occurrence 与 finalization；priority 仅表达调度优先级。
- priority-0 用户草稿只同步不执行；Pi 自建工作可在 reload 后恢复。
- 同一宿主的 Checklist 更新、验收、provisioning 与配置写入使用真实跨进程锁，临界区内重新读取远端；崩溃遗留锁会回收。
- Poller 的远端异常被捕获，不会以未处理 rejection 终止 Pi。
- 已完成工作拒绝 Checklist mutation；完整 Items 写回会保留远端未知字段、日期与时区。
- 跨宿主没有公开 Dida CAS/ETag/幂等创建能力时不承诺 strong consistency 或 exactly-once。

### 7. 空闲主动轮询

扩展默认每 **10 分钟**主动轮询；无需用户配置。会话启动或 `/reload` 后立即检查一次，之后按间隔轮询。仅在 Pi 空闲且没有待处理消息时访问滴答；只有设置了低/中/高优先级的普通未完成顶层工作才触发 LLM turn；无优先级任务视为草稿并静默跳过，清单中只有待验收事项时也完全静默。轮询依赖当前 Pi 进程和会话存活，不是系统 daemon。

### 8. 会话独立与永久历史

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
pi install git:github.com/ztllll/dida-todo@v0.6.2
```

新开任意 Pi 会话，直接告诉 LLM：

```text
登录滴答
```

GitHub 安装会自动安装运行依赖 `@suibiji/dida-cli`；用户不需要另装全局 `dida`，也不需要寻找 Git 包目录。内部 `dida_todo_setup login` 会调用包内 CLI 打开浏览器 OAuth。首次浏览器授权是唯一必须由用户完成的交互。

登录成功后，扩展自动完成：

1. tmux 环境取 tmux session 名称，非 tmux 环境取 cwd basename；
2. 唯一同名清单存在则复用，不存在则创建 TASK/list 清单；
3. 自动持久化精确 tmux target 与 cwd 双绑定；
4. 当前会话立即同步并启用，无需填写 projectId；
5. 空清单明确显示“滴答 Todo 已就绪”，直接口述第一项任务即可；首个 Todo 自动建立顶层工作与 Checklist。

完成“登录滴答”的当前会话无需 `/reload` 或第二次配置。新启动的 Pi 会话会自动加载并复用登录状态。只有当某个 Pi 进程已经运行、用户再从外部安装或升级包时，该存量进程受 Pi Loader 生命周期限制需要执行一次 `/reload`；尚未加载的扩展无法自行让旧进程热更新。

存在多个同名清单时扩展拒绝猜测。用户可直接口述“把当前项目绑定到清单 X / projectId Y”，由内部 setup 工具改绑。设置 `autoProvisionProject: false` 可关闭默认自动 provisioning。

手工登录回退：进入 dida-todo Git 安装目录运行 `./node_modules/.bin/dida auth login`。

升级：

```bash
pi install git:github.com/ztllll/dida-todo@v0.6.2
# 或安装 main：pi install git:github.com/ztllll/dida-todo
```

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
  "pollIntervalMinutes": 10,
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

`pollIntervalMinutes` 默认是 **10 分钟**，可在 `1–1440` 分钟范围内覆盖。自动执行还要求任务日期按任务 `timeZone` 换算后属于今天；非全天任务必须已经到开始/截止时间。昨天的过期任务和明天、后天的未来任务静默跳过。重复任务完成当前实例后由滴答推进到下一次日期，下一实例到当天才再次执行。无日期任务仍只按优先级判断。修改配置后执行 `/reload`。`didaCommand` 是可选高级覆盖；默认解析本项目依赖中的 `@suibiji/dida-cli`。

## 使用示例

在滴答创建：

```text
实现全文搜索
├── 分析现有查询接口
├── 实现索引与排序
└── 添加测试
```

然后在 Pi 输入：

```text
检查 Todo
```

也可以在空清单中直接口述“添加 Todo：修复登录流程”。`/todos` 与 `todo list` 会把空清单显示为“滴答 Todo 已就绪”，而不是报错；第一项 Todo 会自动创建对应顶层工作。

保持 Pi 会话运行时，扩展默认每 10 分钟在空闲状态主动检查。没有 Checklist 的直接任务会由 LLM 根据标题、描述和正文创建步骤；已有 Checklist 的分级任务会同时读取顶层标题、描述、正文与全部子任务后执行。

执行期间你可以在滴答看到 Checklist 完成变化和 Pi 评论。工作结束后，会出现：

```text
🧑‍🔬 待验收：实现全文搜索
```

其中包含原任务描述/正文、解决摘要、测试结果、原任务 ID、提醒和人类操作说明。

## 诚实的限制

1. 定时轮询不是系统 daemon：仅在 Pi 进程和当前会话存活时有效；Pi 退出后由滴答负责提醒。
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

当前 `v0.6.2` 已通过 32 个测试文件、114 项自动测试（另有 1 项默认跳过的隔离真实 Dida 验收）、TypeScript、官方 Extension Loader、包内容与凭据扫描。候选还在当前会话绑定清单完成了真实 CLI 的验收任务、评论、5 个 reminders 与每日重复实例推进验证；跨宿主仍不承诺强一致，因为公开 Dida 接口尚未确认 CAS/ETag 或幂等创建 key。

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

Capture ideas, bugs, and feature requests in Dida365 from your phone or browser. Later, tell Pi to “check Todo”. The LLM synchronizes the project, adopts work, executes Checklist items, writes progress back, and creates a reminder-backed **human acceptance Todo** before the source work can complete.

## Highlights

- **Dida365 as a shared inbox:** humans capture work; the LLM reads and executes it.
- **Natural-language-first UX:** users keep `/todos` and the Overlay; top-level work management stays internal.
- **Complete task semantics:** direct tasks and hierarchical Checklist tasks are both supported. Every execution reads the top-level title, description, body content, and Checklist as one payload. The Overlay retains the complete Checklist for the current conversation, including completed rows.
- **Multi-work queue:** the LLM can process all unfinished top-level tasks using priority and time ranges.
- **Default idle polling:** Pi checks Dida365 every 10 minutes by default, only while idle, and triggers the LLM only for executable unfinished work. The interval is configurable. Priority 0 is treated as a draft and stays silent.
- **Durable history:** clearing or replacing a Pi session does not delete remote work.
- **Mandatory human acceptance:** `WorkFinalizer` prevents source completion until a pending acceptance Todo, report, and feedback comment exist.
- **Feedback loop:** keep acceptance open and add a comment; the next sync exposes the feedback to the LLM, which asks before rework.
- **Same-host resilience:** metadata v2 tracks origin/lifecycle/occurrence; real cross-process locks serialize mutation, finalization, provisioning, and config writes. Poller failures are contained. Cross-host strong consistency is not claimed without a Dida CAS/ETag/idempotency API.

## Model

```text
One fixed Dida365 project per local project / tmux target
├── Top-level work task
│   └── Checklist items (Pi Todos)
└── Human acceptance task (report + reminder + feedback entry point)
```

## Install

```bash
pi install git:github.com/ztllll/dida-todo@v0.6.2
```

In any new Pi session, tell the LLM:

```text
Log in to Dida365
```

The Git package automatically installs `@suibiji/dida-cli`; no global `dida` command is required. The internal `dida_todo_setup login` tool opens browser OAuth through the bundled CLI. Browser authorization is the only required manual step.

After login, dida-todo automatically derives a project name from the tmux session (or cwd basename), reuses the unique same-name project or creates a TASK/list project, persists exact tmux and cwd bindings, and activates the current session. An empty project reports **“Dida Todo is ready”** instead of failing; the first Todo automatically creates its top-level work task and Checklist. Users never need to find a projectId. Ask the LLM to rebind by exact name or projectId when needed. Duplicate names fail safely instead of being guessed.

The session that completes `dida_todo_setup login` is ready immediately—no `/reload` or second setup step. New Pi processes load the installed package automatically. Only Pi processes that were already running before an external install or upgrade need one `/reload`, because an extension that has not been loaded cannot hot-reload its host process by itself.

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
  "pollIntervalMinutes": 10,
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

Exact tmux target matching takes precedence over exact cwd matching. By default, an unbound session reuses the unique same-name project or creates one; it never guesses between duplicate names. Set `autoProvisionProject: false` for fully explicit bindings. `pollIntervalMinutes` defaults to **10 minutes** and can be overridden from 1–1440; the poller checks immediately on startup and then on the interval. Automatic execution also requires the task date, interpreted in its `timeZone`, to be today; timed tasks must have reached their start/due time. Overdue tasks from yesterday and future tasks for tomorrow or later stay silent. Dida365 advances a recurring task to its next occurrence after completion, and that occurrence runs only when its date becomes today. Undated tasks remain priority-gated only. It stays silent while Pi is busy, messages are queued, or no prioritized unfinished top-level work exists. Priority 0 tasks are synchronized but treated as drafts: they do not execute, wake the LLM, or produce a reply. Pending-acceptance tasks alone never wake the LLM. A restored display binding does not count as active execution.

## Usage

Public UI:

```text
/todos
Ctrl+Shift+T
```

Natural-language examples:

```text
Add Todo: fix the login flow
Check Todo
Work on the latest high-priority task
Continue the previous work
Show pending acceptance reports
```

An empty Dida project is a ready state, not an error: `/todos` and `todo list` report readiness, and the first Todo bootstraps the top-level work automatically.

Leave the Pi session running and the extension checks while idle every 10 minutes by default. Direct tasks without a Checklist are decomposed from their title, description, and body content. Hierarchical tasks are executed from both their top-level content and Checklist items, never item titles alone.

Internal tools:

- `todo`: Checklist steps in the current work.
- `todo_work`: internal top-level synchronization, switching, queue progression, and completion.

## Human acceptance invariant

```text
Last Checklist item completes
→ build a report from the original description/body and per-step resolutions
→ create or reuse a pending human-acceptance Todo
→ schedule a reminder two minutes later plus follow-ups at +2/+4/+6/+8 minutes
→ ensure the human feedback comment exists
→ only then complete the source work and detach the Runtime
```

This rule is triggered automatically by the Repository; correctness no longer depends on the LLM remembering `finish_current`. Startup, `/todos`, natural-language sync, and polling also repair stranded work whose Checklist is complete while the top-level task remains open. Acceptance failures leave the source task open and are reported explicitly. Recurring tasks isolate acceptance by occurrence, and `finish_current` remains only as an idempotent recovery action.

## Honest limitations

1. This is not a system daemon. Default 10-minute polling works only while the Pi process and session are alive; Dida365 remains responsible for reminders.
2. Dida365 Checklist items have no native `in_progress` state; that state is primarily visible in the Pi Overlay.
3. Cross-host concurrency, etag conflicts, rate limits, token expiry, and long unattended runs need more field testing.
4. The current scope targets Dida365 and does not claim TickTick International compatibility.
5. Adoption writes managed metadata into the target task; use a dedicated project and test first.
6. It cannot coexist with `rpiv-todo` because both intentionally expose `todo` and `/todos`.

## References and acknowledgements

- [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo): inspiration for the Todo schema, three-state workflow, `/todos`, Overlay, dependencies, and tombstones. `dida-todo` reimplements persistence, synchronization, top-level work, and acceptance around Dida365.
- [`@suibiji/dida-cli`](https://www.npmjs.com/package/@suibiji/dida-cli): public CLI used for Dida365 OAuth, projects, tasks, Checklists, reminders, and comments.
- [Pi Coding Agent](https://github.com/earendil-works/pi): Extension API, tools, TUI, lifecycle, and package system.
- Dida365: remote task platform. This project is not affiliated with or endorsed by Dida365.

Third-party projects remain owned by their respective authors and retain their own licenses and terms.

## Development story

The project was developed through a real Dida365-driven feedback loop: read-only inventory, domain modelling, fake-CLI TDD, real project acceptance, manual Checklist adoption, multi-work execution, scheduling and comments, long-running visual observation, mandatory human acceptance, idle polling, zero-configuration project provisioning, and UX simplification. Release `v0.6.2` passed 114 automated tests across 32 test files plus one opt-in isolated real-Dida gate, TypeScript, the official Extension Loader, package-content inspection, and credential scanning.

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

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before contributing.

## Releases

- Repository: https://github.com/ztllll/dida-todo
- Releases: https://github.com/ztllll/dida-todo/releases
- npm: not published

## License

MIT. Third-party dependencies and referenced projects retain their respective licenses.
