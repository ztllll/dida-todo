# Dida Todo（研究原型）

将 Pi 原有 Todo 体验接入滴答：用户在滴答记录工作，LLM 读取并执行，状态和完成报告写回滴答。

> 源码仓库同时用于开发和发布；用户配置与 OAuth 凭据始终位于仓库之外。

## 数据模型

```text
固定滴答清单
├── 顶层工作任务（一次完整工作）
│   └── Checklist Items（Pi Todo 执行步骤）
└── 待验收 Todo（工作完成报告与提醒）
```

滴答是任务真源；Pi Runtime 只保存当前展示和活动工作。

## 用户界面

与 `@juicesharp/rpiv-todo@2.4.0` 保持一致，只公开：

```text
/todos
Todo Overlay
ctrl+shift+t 折叠/展开
```

`/todos` 每次都会先同步滴答，并显示当前工作的顶层标题、描述、正文和完整 Checklist，因此能看到用户在滴答新增、改名或完成的 Item。Overlay 参考旧 Pi Todo 保持简洁，只显示 Checklist 状态行，并在当前工作对话内持续展示：步骤完成后仍保留已完成行，直到新工作取代它或会话关闭；完整任务语义由同步上下文、`todo_work` 和 `/todos` 提供。

整个队列可由空闲 Poller 自动领取，也可用固定口令立即触发：

```text
检查todo
```

添加、追加、修改、完成和删除使用自然语言表达实际意图，不会顺手扫描其他工作。`检查 todo`、`查看滴答任务`、`同步待办` 等近似表达也不会触发队列。

不公开 `/todo-work` 调试命令。

## Todo 创建门

Todo 表示需要跨工具、跨轮或跨会话持久保存进度的用户工作，不是 Agent 的内部思考清单。普通聊天、简单问答、一次性研究/搜索、只读检查、短命令、诊断但不实施、翻译、润色和总结禁止创建 Todo；工具调用数量不是理由。

每次 `todo create` 必须携带当前用户请求授权的 `trackingReason`：

```text
user_requested_tracking / multi_step_implementation /
cross_turn_recovery / background_or_acceptance / current_work_step
```

输入意图门和工具参数门共同校验：普通消息不会获得任何许可；追加当前工作只能使用 `current_work_step`。理由写入 Checklist metadata，便于审计。

## LLM 内部工具

### `todo`

管理当前顶层工作的 Execution Steps / Checklist Items。用户在滴答创建的任务一旦由 LLM 正式执行，必须至少有一个可见 Checklist Item；没有 Item 的 Direct 任务在创建首个步骤时原地提升。所有滴答可见文字都是面向人的交付内容：只写目标、动作、结果和验收证据，不写思考过程、排查日志、测试脚手架、prompt、managed JSON、binding/session/work/item ID 或 lifecycle。Pi 新建工作仍必须明确 `workType` 和 `workPriority`：Pi Direct 使用整理后的 `subject` 作为任务名并保留内部步骤，Pi Checklist 使用与首个具体 `subject` 不同的智能汇总 `workTitle`。优先级必须为 low/medium/high（1/3/5），priority=0 只保留给用户草稿：

```text
create / update / list / get / delete / clear
```

### `todo_work`

仅供 LLM 内部管理顶层工作队列：

```text
list / switch / next / refresh / finish_current
```

用户无需手工调用。只有同轮精确口令 `检查todo` 或可信空闲 Poller 发现 priority>0 且已到期工作时，才授权 `list/switch/next/refresh`；`finish_current` 无该授权时只收口当前工作，不扫描或切换下一项。待验收评论的身份判定和返工创建均在 Repository 同步 seam 内自动完成，不暴露手工确认动作。

## 显式同步

用户完整输入唯一口令 `检查todo` 时：

1. 读取固定清单全部未完成任务；
2. 自动接管用户手工创建的直接任务或 Checklist 工作；
3. 将顶层标题、描述、正文与 Checklist 作为一个完整任务载荷注入；没有 Item 的用户任务正式执行前必须先生成至少一个精确步骤，并原地提升为 Checklist；
4. 导入用户在滴答侧新增或修改的 Checklist Item；同名 Item 按远端顺序一对一匹配，滴答重写全部 Item ID 后会保存最终服务器 ID，并在同步时净化旧版本造成的重复本机状态；Pi 可在同一用户工作内反复追加人类可读的新 Item，但不能改名或删除用户原始 Item，只能推进状态并写简洁结果；用户要求保持未勾或不适用的 Item 使用本机 `skipped` 终态，远端仍保持未勾但不再阻塞顶层验收；运行时 metadata 存在本机原子状态库，旧任务中的 managed block 会在同步时迁移并从描述/正文清除；
5. 按优先级高→中→低和时间范围向 LLM 提供全部工作；同优先级保持滴答清单返回顺序；
6. 读取待验收报告及评论；
7. Overlay 与滴答状态同步。

`pollIntervalMinutes` 默认 10 分钟，可配置为 1–1440。Poller 只在 Interactive/TUI 主会话中注册；Print/RPC 子会话启动时只建立被动 cwd Runtime，不同步滴答、不自动 provisioning、不继承父 TUI 的 tmux pane，也不启动 Poller，精确 `检查todo` 或显式 setup 仍可按需同步。Interactive 启动前会校验 binding 的 projectId 仍存在；失效 tmux binding 会回退并持久修复到同 cwd 的有效清单。Poller 仅在 Pi 空闲且没有 pending message 时同步；只有优先级大于 0、未完成并满足 `timeZone` 日期/时间门的工作才发送 follow-up 并签发本轮队列授权。同步可以发现未来循环 occurrence，但 priority 不会绕过时间门：非全天任务必须是计划当天且当前时间不早于 `startDate`（缺失时回退 `dueDate`），全天任务只判断计划日期。提前轮询不会预约单项 timer；到点后的下一次轮询自动领取，也可完整输入 `检查todo` 立即触发。过期 occurrence 不自动补跑。

## 强制人类验收闭环

Repository 固化并自动触发以下不变量：

```text
Pi 自建 Direct Work 全部 Execution Steps 完成，或 Checklist Work 通过 finish_current 明确整体完成
→ 等待 Agent settled 并重新确认仍无未完成步骤及对应顶层完成信号
→ 根据原任务描述/正文、Checklist 与 metadata.resolution 生成安全占位报告
→ 幂等创建或复用待验收 Todo
→ 设置完成后 +3/+6 分钟两次提醒
→ 补齐评论反馈入口
→ 验收 Todo 与评论成功后才完成原工作
→ 完成源任务并保留待回填源记录
→ Agent 最终回复稳定后，原样回填待验收 desc/正文并生成结果型标题
→ 下一项 Todo 建立新顶层工作
```

一条用户消息中的相关要求属于一个完整请求批次：一个顶层工作、全部必要 Items、一个统一最终回复和一条待验收。任何新 Item 追加到 `ready_for_acceptance` 工作时都会撤销旧收口状态；全部完成后必须重新 `finish_current`。启动、`/todos` 与精确口令同步会修复符合完成语义的夹生任务。验收创建或评论转换失败时保持旧验收并返回可观察错误。重复任务使用 `sourceWorkId + sourceOccurrence` 隔离每次验收。待验收系统引导评论的 `userId` 作为 OAuth 用户身份：同一 `userId` 的后续评论在 Repository 内原子转换为独立返工工作并关闭旧验收；不同账号、缺失 `userId` 或缺失引导评论时 fail closed，完全静默忽略。任务描述/正文只承载报告和说明，不是控制通道；已完成源 Checklist 永不回滚。人类点击完成后闭环结束。

## 调度字段

扩展读取并保留：

```text
priority / startDate / dueDate / timeZone / isAllDay / reminders / repeatFlag
```

Checklist 更新不会覆盖这些字段。Pi 新建工作必须主动选择 low/medium/high；历史 Pi priority=0 在同宿主锁内重读后迁移为 low=1，用户手工 priority=0 保持草稿。循环任务每次以当前 `startDate ?? dueDate` 形成 occurrence key，上一轮 claim/finalization/验收不能复用于下一轮。完整调度和运行中升级边界见 [`docs/operations/recurring-scheduling-and-live-upgrades.md`](../../docs/operations/recurring-scheduling-and-live-upgrades.md)。

## 安全语义

- `todo clear` 只解除当前活动工作，不删除滴答数据。
- 用户清空或切换 Pi 会话不会删除滴答历史。
- 提醒任务和验收任务不会被接管成普通实现工作。
- 同宿主 Checklist mutation、验收收口、provisioning 与配置写入使用原子目录跨进程锁；锁内重新读取远端状态。跨宿主没有公开 CAS/ETag/幂等创建 key 时不承诺强一致或 exactly-once。

## 零配置初始化与绑定

GitHub 安装会自动安装包依赖 `@suibiji/dida-cli`。用户在 Pi 中直接说：

```text
登录滴答
```

内部 `dida_todo_setup login` 会调用包内 CLI 打开浏览器 OAuth；也可手工运行 `./node_modules/.bin/dida auth login`。登录成功后立即 provisioning：

- 首次自动 provisioning 使用 `[hostname][channel] route-name`；channel/route 通过 tmuxbot canonical Admin inventory 按精确 tmux target 探测；
- 无 tmuxbot route、inventory 失败或结果歧义时 fail closed 为 `[hostname] tmux-session-or-cwd`，绝不猜 IM 通道；
- credential、chat_id、thread_id 和 token 均不进入清单名或配置 label；
- 唯一同名清单自动复用，无同名清单自动创建；
- 自动保存精确 tmux target 绑定到 `~/.config/pi-dida-todo/config.json`，权限 `0600`；cwd alias 只在未被另一 route 占用或指向同一 project 时写入；
- 多个同名清单时拒绝猜测，用户可口述要求 LLM 按 projectId 改绑；
- `autoProvisionProject: false` 可关闭自动创建，回到完全显式绑定模式。
- 完成“登录滴答”的当前会话会立即激活，无需 `/reload` 或第二次配置；空清单的 `/todos` 与 `todo list` 会明确显示“滴答 Todo 已就绪”，首个 Todo 自动建立顶层工作。
- 仅当包是在某个 Pi 进程已经运行后从外部安装或升级时，该存量进程受 Pi Loader 生命周期限制需要一次 `/reload`；新启动 Pi 自动加载。
- 不得在使用 dida-todo 的 Pi 进程正执行工作时覆盖共享 Git Package checkout。安装会 reset/clean 安装目录并重装依赖，但存量进程仍保留旧 Runtime，可能形成旧内存代码与新磁盘 CLI/依赖混用。必须先等待相关 pane idle，再安装固定版本，随后 `/reload` 或启动新进程。

内部 `dida_todo_setup` 工具支持 `login`、`auto` 和 `bind`，用户无需直接调用。

## 验证

```bash
npm run check
```

真实写入候选验收默认跳过；仅在显式设置 `DIDA_TODO_REAL_CANDIDATE=1` 和一次性专用 `DIDA_TODO_REAL_PROJECT_ID` 后执行，绝不可指向用户工作清单或生产 route。候选验收必须手工复核：重复实例推进、OAuth 过期后重新登录、两个 Pi 进程并发 Checklist/收口，以及验收评论与 reminders 的真实 CLI 行为。

## 链接与附件

官方 Dida OpenAPI 的 Task/Comment schema 没有附件字段，也没有上传、下载或图片评论 endpoint。因此 dida-todo 不能可靠读取滴答原生附件，也不会调用私有 API 上传结果文件。任务 content、desc 和 Checklist 中的 `http/https` 链接随完整任务载荷注入并作为不可信外部资源处理。API/CLI 虽能读回普通评论链接，但当前普通工作评论不进入执行载荷；待验收评论仅用于身份门控返工。经 tmuxbot 使用时，Telegram/飞书文件可下载到受控本地路径；完成后的真实本地图片/文件可通过最终回复上传回同一精确 IM endpoint。

## 已知限制

1. 滴答 Item 没有原生 `in_progress`，该状态保存在顶层任务受管元数据中；滴答侧显示为未完成，Pi Overlay 显示为进行中。
2. Dida CLI 更新需要发送完整 Items；同宿主已由真实跨进程锁保护。公开 API 未确认提供 CAS/ETag 条件更新或幂等创建 key，因此跨宿主只能检测/拒绝冲突，不能承诺强一致或 exactly-once。
3. 自动收口需要 gateway 同时支持创建验收、读取评论与写入评论；能力不完整时必须保持源工作未完成。
4. 官方 OpenAPI 不支持原生附件；文件交付依赖当前 IM transport 或外部 HTTPS 链接。
5. Repository 会把合法本人评论转换为普通返工工作；异账号或缺失身份的评论不会进入队列或展示。
6. 本工作区不是生产部署位置，未经授权不得复制到全局 Pi 配置。
