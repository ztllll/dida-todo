# dida-todo 扩展说明

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

`/todos` 每次都会先同步滴答，再显示当前工作，因此能看到用户在滴答新增、改名或完成的 Checklist Item。

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

用户无需手工调用。`finish_current` 进入 Repository 完成流程，不负责决定是否创建验收 Todo。

## 自动同步

用户说“检查 Todo / 查看滴答任务 / 同步待办”时：

1. 读取固定清单全部未完成任务；
2. 自动接管用户手工创建的 Checklist 工作；
3. 导入用户新增或修改的 Checklist Item；
4. 仅将设置了低/中/高优先级的未完成工作提供给 LLM；无优先级任务作为草稿静默保留；
5. 读取待验收报告及评论；
6. Overlay 与滴答状态同步。

可选配置 `pollIntervalMinutes`（1–1440）：启动时立即检查一次，之后在 Pi 空闲且没有待处理消息时定时读取滴答。只有设置了低/中/高优先级的普通未完成顶层工作才触发 LLM turn；无优先级任务视为用户仍在编辑的草稿，保持同步但不执行、不回复；只有待验收任务时也完全静默。会话关闭时自动清理 timer。

## 强制人类验收闭环

`DidaTodoRepository.finishWork()` 固化以下不变量：

```text
全部 Checklist 完成
→ 根据 Checklist 与 metadata.resolution 生成报告
→ 幂等创建或复用待验收 Todo
→ 设置默认两分钟后的准时提醒
→ 验收 Todo 创建成功后立即写入评论入口
→ 验收 Todo 与评论创建成功后才完成原工作
```

LLM、命令或脚本都不能绕过。待验收 Todo 保持未完成时，LLM 下次检查会读取报告和评论，但不会因“尚未点击完成”擅自判定失败或自动返工；有反馈时先询问用户。人类点击完成后闭环结束。

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
- Checklist 修改通过父任务文件队列串行化。

## 配置

默认位置：

```text
~/.config/pi-dida-todo/config.json
```

每个 tmux target 或 cwd 必须显式绑定一个固定滴答清单；扩展不会猜测或自动创建清单。

## 验证

```bash
npm run check
```

真实写入测试仅在固定专用清单中显式执行。

## 已知限制

1. 滴答 Item 没有原生 `in_progress`，该状态保存在顶层任务受管元数据中；滴答侧显示为未完成，Pi Overlay 显示为进行中。
2. Dida CLI 更新需要发送完整 Items；已做进程内/文件队列串行化，跨宿主并发和 etag 冲突仍需继续测试。
3. 定时轮询只在 Pi 进程和当前会话存活时有效，不是系统级后台服务。
4. 无优先级任务不会进入执行队列；需要执行时请在滴答中设置低、中或高优先级。
5. 跨宿主并发、OAuth 长期恢复和限流仍需更多真实环境验证。
