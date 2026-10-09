# AGENTS.md

dida-todo 是 Pi Agent 扩展：滴答清单（Dida365）作为人与 Agent 共享的任务真源，Agent 执行并回写进度，完成后由人验收。只支持 Pi（TUI 与 Web/RPC）。用户文档见 [README.md](README.md)。

## 常用命令

```bash
npm ci
npm run check        # 结构/凭据扫描 + typecheck + vitest + pack dry-run
git diff --check
```

真实滴答测试默认跳过；仅在一次性专用清单上运行：`DIDA_TODO_REAL_CANDIDATE=1 DIDA_TODO_REAL_PROJECT_ID=<id> npx vitest run tests/dida-todo/real-dida.candidate.test.ts`，结束后清理。

## 领域词汇

- **Binding**：tmux target 或 cwd → 一个滴答清单。精确 tmux 优先于 cwd；未绑定目录被动，只有 `/dida-bind` 才绑定/按输入名称建清单。
- **Work**：清单里的顶层任务 = 一次完整用户请求。同一请求的追加要求归入同一 Work，只验收一次。
- **Direct / Checklist**：Direct 用本机内部步骤；Checklist 用滴答可见子项。用户创建的 Direct 任务被领取时原地提升为 Checklist。
- **Queue Grant**：只有精确输入 `检查todo` 或可信 Poller 能授权扫描整个队列；普通 Todo 修改不扫描。
- **Occurrence**：循环任务的一次实例（`startDate ?? dueDate`），领取、收口、验收按实例隔离，过期不补跑。
- **Acceptance Todo**：Work 全部子项完成/跳过后自动生成的 `🧑‍🔬 待验收` 任务（+3/+6 分钟提醒）。本人评论自动变成返工。
- **Waiting for human**：`todo_work wait_for_human` 挂起的 Work。滴答优先级清零（Poller 不再领取）、生成 `🙋` 提醒，任务保持未完成；用户改回优先级或 `resume` 即恢复。
- **Human Task Surface**：滴答上人能看到的文字，只写目标、动作、结果；运行时 metadata 只存本机状态库。

## 模块地图（`extensions/dida-todo/`）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Pi 入口 | `index.ts` | `session_start` / `input` / `agent_end` / `agent_settled` / `session_shutdown` / `session_compact` |
| 工具与界面 | `tool.ts`、`work-tool.ts`、`setup-tool.ts`、`commands.ts`、`overlay.ts` | `todo`、`todo_work`、`dida_todo_setup`、`/todos`、`/dida-bind`、面板 |
| 会话 | `runtime.ts`、`replay.ts`、`poller.ts`、`input-sync.ts` | 会话状态、reload 快照重放、空闲轮询（含无变化不重复唤醒）、队列授权 |
| 核心 | `repository.ts` | 同步、领取、子项修改、挂起/恢复、收口、返工；锁内重读远端 |
| 生命周期 | `work-lifecycle.ts`、`work-type.ts`、`work-queue.ts`、`scheduling.ts` | metadata v2、occurrence 接管、优先级/时间门、提醒任务 |
| 验收 | `work-finalizer.ts`、`settled-finalization.ts`、`acceptance.ts`、`acceptance-result.ts` | 待验收任务、提醒、身份门返工、最终回复回填 |
| 存储 | `state-store.ts`、`host-lock.ts`、`codec.ts`、`human-task-surface.ts` | 本机状态库、跨进程锁、旧 managed block 迁移 |
| 外部 | `gateway.ts`、`provisioning.ts`、`config.ts` | 调用 `@suibiji/dida-cli`、绑定、配置 |

本机文件：`~/.config/pi-dida-todo/config.json`（绑定，0600）、`~/.local/state/pi-dida-todo/work-state.json`（WorkMetadata 与验收关联）、`$TMPDIR` 下的锁文件。

## 宿主模式

| 模式 | 面板 | 启动同步 | Poller |
| --- | --- | --- | --- |
| TUI（已绑定） | 是 | 是 | 是 |
| Web/RPC（已绑定，如 pi-web） | 是 | 是 | 否（RPC 下 `isIdle()` 恒为 true） |
| Print/JSON（`hasUI=false`） | 否 | 否 | 否 |
| 未绑定目录 | 被动 | 否 | 否 |

## 不可破坏的规则

- 没有未完成的待验收 Todo，源 Work 不能 completed；全部子项完成/跳过后顶层必须自动收口（`keepOpen` 除外）。
- 推进子项状态（in_progress / completed / skipped）就会接管当前 occurrence；不得依赖 Agent 先标 in_progress。
- 用户原始子项只能推进状态，不能改名或删除。
- priority=0 不自动执行；`waitingForHuman` 的 Work 不能被 Pi 的 priority 迁移改回。
- 等待人类时禁止把未完成子项标 completed/skipped 来止住轮询。
- 滴答可见文字不得出现思考过程、prompt、ID、lifecycle。
- 不提交 OAuth Token、真实任务数据、日志、会话文件或本地绝对路径。

## 改动与发布

1. 行为改动先写失败测试（`tests/dida-todo/`，用假 gateway），再改代码。
2. 用户可见行为变化同步 README；调度、Poller、安装生命周期变化同步 README 的“调度”和“升级”两节。
3. 更新 `package.json` 版本、`tests/dida-todo/package.test.ts` 版本断言与 `CHANGELOG.md`；`npm run check` 通过后提交，打 tag `vX.Y.Z` 推送。只走 GitHub，不发 npm。
4. 安装：等使用 dida-todo 的 Pi 进程空闲 → `pi install git:github.com/ztllll/dida-todo@vX.Y.Z` → 对每个已运行进程 `/reload`。
