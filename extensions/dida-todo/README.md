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

其他操作使用自然语言：

```text
检查 Todo
处理最新的高优先级任务
看看待验收报告
继续上次工作
```

不公开 `/todo-work` 调试命令。

## LLM 内部工具

### `todo`

管理当前顶层工作中的 Checklist：

```text
create / update / list / get / delete / clear
```

### `todo_work`

仅供 LLM 内部管理顶层工作队列：

```text
list / switch / next / refresh / finish_current
```

用户无需手工调用。`finish_current` 进入 Repository 完成流程，不负责决定是否创建验收 Todo。待验收评论的身份判定和返工创建均在 Repository 同步 seam 内自动完成，不暴露手工确认动作。

## 自动同步

用户说“检查 Todo / 查看滴答任务 / 同步待办”时：

1. 读取固定清单全部未完成任务；
2. 自动接管用户手工创建的直接任务或 Checklist 工作；
3. 将顶层标题、描述、正文与 Checklist 作为一个完整任务载荷注入；直接任务根据全部顶层内容拆解，分级任务也不会只读取子任务标题；
4. 导入用户新增或修改的 Checklist Item；
5. 按优先级和时间范围向 LLM 提供全部工作；
6. 读取待验收报告及评论；
7. Overlay 与滴答状态同步。

`pollIntervalMinutes` 默认是 **10 分钟**（可配置范围 1–1440），无需用户手工配置：会话启动或 `/reload` 后立即检查一次，之后在 Pi 空闲且没有待处理消息时定时读取滴答。执行门为：优先级大于 0、任务未完成，并且任务的 `startDate`/`dueDate` 按 `timeZone` 换算后属于今天；非全天任务还必须已经到点。昨天、明天和后天都静默跳过，无日期任务仍只按优先级判断。重复任务完成当前实例后由滴答推进日期，只有新实例到当天才再次执行。无优先级、只有待验收、Pi 忙碌或消息排队时也完全静默。Runtime 中恢复/展示的工作绑定不等于 LLM 正在执行，不会阻止轮询。会话关闭时自动清理 timer。

## 强制人类验收闭环

Repository 固化并自动触发以下不变量：

```text
最后一个 Checklist 完成
→ 根据原任务描述/正文、Checklist 与 metadata.resolution 生成报告
→ 幂等创建或复用待验收 Todo
→ 设置完成后 +3/+6 分钟两次提醒
→ 补齐评论反馈入口
→ 验收 Todo 与评论成功后才完成原工作
→ detach 当前 Runtime，下一项 Todo 建立新顶层工作
```

正确性不再依赖 LLM 记得调用 `todo_work finish_current`；该动作仅保留为幂等恢复入口。启动、`/todos`、自然语言同步与轮询会自动修复 Checklist 已全完成但顶层未完成的夹生任务。验收创建或评论转换失败时保持旧验收并返回可观察错误。重复任务使用 `sourceWorkId + sourceOccurrence` 隔离每次验收。待验收系统引导评论的 `userId` 作为 OAuth 用户身份：同一 `userId` 的后续评论在 Repository 内原子转换为独立返工工作并关闭旧验收；不同账号、缺失 `userId` 或缺失引导评论时 fail closed，完全静默忽略。任务描述/正文只承载报告和说明，不是控制通道；已完成源 Checklist 永不回滚。人类点击完成后闭环结束。

## 调度字段

扩展读取并保留：

```text
priority / startDate / dueDate / timeZone / isAllDay / reminders / repeatFlag
```

Checklist 更新不会覆盖这些字段。

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

- tmux 环境默认以 tmux session 名称寻找或创建滴答 TASK/list 清单；
- 非 tmux 环境默认使用 cwd basename；
- 唯一同名清单自动复用，无同名清单自动创建；
- 自动保存精确 tmux target 与 cwd 双绑定到 `~/.config/pi-dida-todo/config.json`，权限 `0600`；
- 多个同名清单时拒绝猜测，用户可口述要求 LLM 按 projectId 改绑；
- `autoProvisionProject: false` 可关闭自动创建，回到完全显式绑定模式。
- 完成“登录滴答”的当前会话会立即激活，无需 `/reload` 或第二次配置；空清单的 `/todos` 与 `todo list` 会明确显示“滴答 Todo 已就绪”，首个 Todo 自动建立顶层工作。
- 仅当包是在某个 Pi 进程已经运行后从外部安装或升级时，该存量进程受 Pi Loader 生命周期限制需要一次 `/reload`；新启动 Pi 自动加载。

内部 `dida_todo_setup` 工具支持 `login`、`auto` 和 `bind`，用户无需直接调用。

## 验证

```bash
npm run check
```

真实写入候选验收默认跳过；仅在显式设置 `DIDA_TODO_REAL_CANDIDATE=1` 和一次性专用 `DIDA_TODO_REAL_PROJECT_ID` 后执行，绝不可指向用户工作清单或生产 route。候选验收必须手工复核：重复实例推进、OAuth 过期后重新登录、两个 Pi 进程并发 Checklist/收口，以及验收评论与 reminders 的真实 CLI 行为。

## 已知限制

1. 滴答 Item 没有原生 `in_progress`，该状态保存在顶层任务受管元数据中；滴答侧显示为未完成，Pi Overlay 显示为进行中。
2. Dida CLI 更新需要发送完整 Items；同宿主已由真实跨进程锁保护。公开 API 未确认提供 CAS/ETag 条件更新或幂等创建 key，因此跨宿主只能检测/拒绝冲突，不能承诺强一致或 exactly-once。
3. 自动收口需要 gateway 同时支持创建验收、读取评论与写入评论；能力不完整时必须保持源工作未完成。
4. 默认有 10 分钟一次的会话内空闲轮询，但它只在 Pi 进程和当前会话存活时有效，不是系统级后台服务；Pi 退出后仍由滴答负责提醒。
5. 轮询只负责普通可执行工作；Repository 已把合法本人评论转换为普通返工工作。异账号或缺失身份的评论不会进入队列、不会唤醒、不会展示。
6. 本工作区不是生产部署位置，未经授权不得复制到全局 Pi 配置。
