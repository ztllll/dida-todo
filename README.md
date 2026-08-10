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

- 支持用户手工创建顶层 Checklist 工作任务。
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
- Pi Overlay 展示 `pending / in_progress / completed`。
- 滴答 Checklist 没有原生“进行中”，该状态由受管元数据保存；滴答侧仍显示未完成。

### 4. 多工作任务与调度

- 一个项目或 tmux 工作目标固定绑定一个滴答清单。
- 顶层 Task 表示一次完整工作，Checklist Items 表示执行步骤。
- LLM 可遍历全部未完成顶层任务，而不是只处理第一项。
- 读取并保留优先级、开始/截止时间、时区、全天、提醒和重复字段。

### 5. 强制人类验收闭环

验收不是靠 LLM“记得做”，而是 Repository 的完成不变量：

```text
全部 Checklist 完成
→ 根据每一步 resolution 生成完成报告
→ 幂等创建/复用 🧑‍🔬 待验收 Todo
→ 设置默认两分钟后的准时提醒
→ 验收 Todo 创建成功后，才完成原工作
```

- 人类验收通过：在滴答完成验收 Todo，闭环结束。
- 需要调整：保持验收 Todo 未完成并评论；下次“检查 Todo”时，LLM 会读取反馈并先询问，再决定是否返工。
- “尚未点击完成”只代表尚未闭环，不会被自动判定为实现失败。

### 6. 会话独立与永久历史

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

### 要求

- Node.js `>=20`
- Pi Coding Agent
- 滴答清单账号
- 一个专用于当前项目或工作目标的滴答清单

### 从 GitHub Release 安装

```bash
pi install git:github.com/ztllll/dida-todo@v0.1.0
```

也可以先试用而不写入安装配置：

```bash
pi -e git:github.com/ztllll/dida-todo@v0.1.0
```

本项目当前**只以 GitHub 为正式发布渠道，不发布 npm 包**。包内已依赖 `@suibiji/dida-cli`，无需全局安装 `dida`。

### 冲突迁移

必须禁用 `@juicesharp/rpiv-todo` 或其他同时注册以下接口的扩展：

```text
todo 工具
/todos 命令
```

`dida-todo` 会在启动时检测冲突并明确报错，不会静默覆盖。它可以与 `@narumitw/pi-statusline`、`pi-updater` 和纯主题包共存。

## 滴答登录

安装后，进入 Pi 安装的 Git 包目录或任意安装了本项目依赖的目录，运行：

```bash
./node_modules/.bin/dida auth login
```

OAuth Token 保存在用户配置目录，不应写入项目或提交到 Git。

## 配置

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

绑定优先级：精确 tmux target → 精确 cwd。扩展不会猜测清单，也不会自动创建业务清单。

`didaCommand` 是可选高级覆盖；默认解析本项目依赖中的 `@suibiji/dida-cli`。

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

执行期间你可以在滴答看到 Checklist 完成变化和 Pi 评论。工作结束后，会出现：

```text
🧑‍🔬 待验收：实现全文搜索
```

其中包含解决摘要、测试结果、原任务 ID、提醒和人类操作说明。

## 诚实的限制

1. 当前不是后台 daemon：滴答负责定时提醒，用户输入触发 LLM 同步与执行。
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

发布前已通过 45 项自动测试、Git 安装、Pi 临时加载、包内容与凭据扫描。真实环境仍可能暴露新的边界，欢迎通过 Issues 反馈。

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
- **Bidirectional Checklist sync:** titles and completion state flow between Dida365 and Pi.
- **Multi-work queue:** the LLM can process all unfinished top-level tasks using priority and time ranges.
- **Durable history:** clearing or replacing a Pi session does not delete remote work.
- **Mandatory human acceptance:** source work cannot complete until a pending acceptance Todo with a completion report and reminder exists.
- **Feedback loop:** keep acceptance open and add a comment; the next sync exposes the feedback to the LLM, which asks before rework.

## Model

```text
One fixed Dida365 project per local project / tmux target
├── Top-level work task
│   └── Checklist items (Pi Todos)
└── Human acceptance task (report + reminder + feedback entry point)
```

## Install

Requirements: Node.js `>=20`, Pi Coding Agent, a Dida365 account, and a dedicated Dida365 project.

```bash
pi install git:github.com/ztllll/dida-todo@v0.1.0
```

Temporary trial:

```bash
pi -e git:github.com/ztllll/dida-todo@v0.1.0
```

GitHub is the only official release channel. This project is **not published to npm**. `@suibiji/dida-cli` is installed as a dependency, so a global `dida` installation is unnecessary.

Disable `@juicesharp/rpiv-todo` and any extension that also registers `todo` or `/todos`. `dida-todo` detects these conflicts and fails clearly instead of silently overriding them.

## Login and configuration

Authenticate through the bundled dependency:

```bash
./node_modules/.bin/dida auth login
```

Create `~/.config/pi-dida-todo/config.json`:

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "autoResumeSingle": true,
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

Exact tmux target matching takes precedence over exact cwd matching. The extension never guesses or creates business projects.

## Usage

Public UI:

```text
/todos
Ctrl+Shift+T
```

Natural-language examples:

```text
Check Todo
Work on the latest high-priority task
Continue the previous work
Show pending acceptance reports
```

Internal tools:

- `todo`: Checklist steps in the current work.
- `todo_work`: internal top-level synchronization, switching, queue progression, and completion.

## Human acceptance invariant

```text
All Checklist steps complete
→ build a report from per-step resolutions
→ create or reuse a pending human-acceptance Todo
→ schedule a default reminder two minutes later
→ only then complete the source work
```

This rule lives in the Repository, not in an LLM prompt, so tools and scripts cannot bypass it.

## Honest limitations

1. This is not a background daemon. Dida365 provides reminders; user input triggers LLM synchronization and execution.
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

The project was developed through a real Dida365-driven feedback loop: read-only inventory, domain modelling, fake-CLI TDD, real project acceptance, manual Checklist adoption, multi-work execution, scheduling and comments, long-running visual observation, mandatory human acceptance, and UX simplification. Before publication it passed 45 automated tests, Git installation, Pi temporary loading, package-content inspection, and credential scanning.

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
