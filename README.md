# dida-todo

[中文](#中文) · [English](#english)

> 让滴答清单成为人与 Pi Agent 共享的长期工作入口：人随时记录，Agent 领取执行，进度实时回写，完成后由人验收。

# 中文

`dida-todo` 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 扩展。它保留 `todo` 工具、`/todos` 命令和编辑器上方的 Todo 面板，但把**滴答清单作为任务真源**。

## 工作方式

```text
人在滴答记录任务并设优先级
→ Pi 空闲时自动领取（或完整输入“检查todo”立即执行）
→ Agent 按 Checklist 执行，每步结果写成滴答评论
→ 全部完成：顶层任务自动完成，并生成“🧑‍🔬 待验收”任务（+3/+6 分钟提醒）
→ 人完成验收任务即闭环；在验收任务下本人评论 = 自动返工
```

数据模型：

```text
一个滴答清单（绑定一个项目 / tmux pane）
├── 顶层工作任务（一次完整请求）
│   └── Checklist 子项（Agent 的执行步骤）
├── 🧑‍🔬 待验收任务
└── 🙋 需要你处理（Agent 挂起等待你时的提醒）
```

## Agent 什么时候建 Todo

在已绑定会话里，Agent 在开始工作前判断，满足任一条件就建一个顶层工作并一次写好所有子项：

1. 你明确要求追踪 / 记录 / 加 Todo；
2. 请求有 3 个及以上独立交付步骤（例如多处修复、代码 + 测试 + 文档）；
3. 工作会跨轮或跨会话；
4. 后台 / 轮询执行，需要事后验收。

聊天、问答、只读排查、调研总结、单条命令、一处小改动都不会建 Todo。

## 任务卡住、需要你时

Agent 遇到必须由人确认、授权、决策或线下操作才能继续的任务时，会调用 `todo_work wait_for_human`：

- 滴答上这个任务的**优先级被清零**，轮询不再领取，不会每 10 分钟刷屏；
- 新建一条 `🙋 需要你处理：<任务名>`，写明原因，**+3 / +6 分钟提醒两次**；
- 原任务**保持未完成**，不会被硬勾掉，并写一条原因评论。

恢复方式（任选其一）：在滴答**把原任务优先级改回低/中/高**，或在 Pi 里让 Agent “继续 xxx”。恢复后 `🙋` 提醒自动完成。

兜底：即使 Agent 没有调用挂起，只要队列自上次唤醒后没有任何变化（没有进展、你也没有编辑），轮询也不会再重复唤醒 Agent。

## 两种任务的完成规则

- **直接任务**（只有描述）：Agent 建一个可见步骤并完成，顶层随之完成。
- **Checklist 任务**（若干子项）：所有子项完成或跳过后，**顶层任务自动完成**，Agent 不需要自己去勾顶层。只有你明确要求“顶层保持未完成”时才会保留。
- 循环任务按实例执行：今天的实例完成只影响今天，到点后下一次轮询领取，错过的实例不补跑。

## 安装

```bash
pi install git:github.com/ztllll/dida-todo@v0.7.0
```

新开 Pi 会话后：

1. 对 Agent 说“登录滴答”（浏览器 OAuth，依赖已随包安装）；
2. 执行 `/dida-bind [清单名称]`：唯一同名清单直接绑定，不存在则按输入名称创建，取消则什么也不做。

升级时先等正在使用 dida-todo 的 Pi 空闲，再安装新版本，然后对每个已运行的 Pi 执行 `/reload`。忙碌时覆盖安装可能让旧进程与新文件混用。

与 `rpiv-todo` 冲突（两者都注册 `todo` 和 `/todos`），需先禁用。

## 使用

| 操作 | 方式 |
| --- | --- |
| 看当前工作 | `/todos`；`Ctrl+Shift+T` 折叠/展开面板 |
| 立即执行整个队列 | 完整输入 `检查todo`（近似说法不会触发） |
| 加 / 改 / 完成 Todo | 自然语言，只操作对应工作，不扫描队列 |
| 暂存草稿 | 在滴答创建任务但不设优先级，不会被执行 |
| 恢复挂起任务 | 滴答改回优先级，或对 Agent 说“继续” |

## 调度规则

- 轮询默认 10 分钟（`pollIntervalMinutes` 可设 1–1440），只在 Pi 空闲且无待处理消息时运行，只在 TUI 会话里运行。
- 只执行：优先级为低/中/高、未完成、且已到计划时间的任务。按优先级高→中→低，同级保持滴答顺序。
- 计划时间 = `startDate ?? dueDate`，按任务时区判断。非全天任务需当天且已到点；全天任务只看日期；没有日期则随时可执行。

## 宿主模式

| 模式 | 面板 | 启动同步 | 自动轮询 |
| --- | --- | --- | --- |
| TUI（已绑定） | 是 | 是 | 是 |
| Web/RPC（如 pi-web） | 是 | 是 | 否 |
| Print（`pi -p`） | 否 | 否 | 否 |
| 未绑定目录 | 被动 | 否 | 否 |

Pi 自带的 `--mode rpc` CLI 客户端只渲染字符串，看不到面板；pi-web 正常。

## 配置

`~/.config/pi-dida-todo/config.json`（`/dida-bind` 会自动写入）：

```json
{
  "pollIntervalMinutes": 10,
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "autoResumeSingle": true,
  "bindings": [
    { "key": "tmux:my-project:0.0", "cwd": "/abs/path", "projectId": "DIDA_PROJECT_ID", "label": "my-project" },
    { "key": "cwd:/abs/path", "projectId": "DIDA_PROJECT_ID", "label": "my-project" }
  ]
}
```

精确 tmux target 优先于精确 cwd；绑定的清单被删除时回退到同 cwd 的有效绑定。

## 限制

1. 滴答官方 API 没有附件接口：链接可用，文件请走 IM 通道。
2. 滴答子项没有“进行中”状态，只在 Pi 面板显示。
3. 同一台机器上的并发写有跨进程锁；多台机器之间没有强一致保证（滴答 API 无 CAS/ETag）。
4. 只针对滴答清单，不保证 TickTick 国际版。
5. 等待人类的去重记录在内存中，重启 Pi 后会对未变化的队列重新唤醒一次。

## 开发

```bash
git clone https://github.com/ztllll/dida-todo.git && cd dida-todo
npm ci && npm run check
```

开发约定见 [AGENTS.md](AGENTS.md)，安全问题见 [SECURITY.md](SECURITY.md)，变更见 [CHANGELOG.md](CHANGELOG.md)。

致谢：[`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)（Todo 交互设计）、[`@suibiji/dida-cli`](https://www.npmjs.com/package/@suibiji/dida-cli)（滴答 CLI）、[Pi](https://github.com/earendil-works/pi)。与滴答官方无隶属关系。

维护者：Ztllll（[@ztllll](https://github.com/ztllll)）。只在 GitHub 发布，不发 npm。MIT 许可。

---

# English

`dida-todo` is a [Pi Coding Agent](https://github.com/earendil-works/pi) extension that makes Dida365 the durable source of truth for the `todo` tool, `/todos`, and the Todo panel.

- **Flow:** capture tasks in Dida with a priority → the idle TUI poller (or the exact input `检查todo`) claims due work → the agent works the Checklist and posts per-step results → when every Item is completed or skipped, the top-level task completes automatically and a `🧑‍🔬` acceptance task with two reminders (+3/+6 min) is created. A comment from your own account on it creates a rework.
- **When the agent creates a Todo:** you ask for tracking, the request has 3+ distinct deliverables, the work spans turns/sessions, or a background run needs acceptance. Never for chat, Q&A, read-only inspection, research, or a single small action.
- **Blocked on a human:** the agent calls `todo_work wait_for_human`. The task's priority is cleared (polling stops), a `🙋` reminder fires twice, and the task stays open. Restore its priority in Dida, or ask the agent to resume. As a fallback, the poller never re-wakes the agent for a queue that has not changed.
- **Install:** `pi install git:github.com/ztllll/dida-todo@v0.7.0`, then say “log in to Dida” and run `/dida-bind [name]`. Install while Pi is idle, then `/reload` running sessions.
- **Hosts:** TUI gets panel + sync + poller; Web/RPC (pi-web) gets panel + sync, no poller; Print and unbound directories stay passive.
- **Limits:** no attachment API; Checklist Items have no native in-progress state; no cross-machine strong consistency; Dida365 only.

Development rules: [AGENTS.md](AGENTS.md). MIT license.
