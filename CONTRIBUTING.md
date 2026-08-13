# 贡献指南 / Contributing

中文优先；English follows.

## 中文

感谢参与 `dida-todo`。

1. Fork 仓库并创建聚焦单一问题的分支。
2. 不得提交 OAuth Token、滴答配置、真实任务 ID、日志、会话文件或本地绝对路径。
3. 提交前运行：
   ```bash
   npm ci
   npm run check
   ```
4. 用户交互保持自然语言优先；`/todos` 是唯一公开 Todo slash command。
5. 必须保持核心不变量：没有未完成的人类验收 Todo，源工作不能进入 completed。
6. 改动任务模型、完成语义或远端数据格式时，请同时补充测试和 README。
7. 改动调度、循环任务、Poller 或 Package 加载/升级生命周期时，必须同步更新 `docs/operations/recurring-scheduling-and-live-upgrades.md`。
8. OpenClaw、Claude Code、Codex 或其他宿主适配必须先阅读 `DEVELOPMENT.md` 与 `docs/development/multi-cli-adapter-development-guide.md`，保持 Pi Adapter 冻结兼容、独立 namespace、Turn Grant 和真实宿主验收要求。
9. PR 请说明：问题、方案、风险、测试方式，以及是否影响既有滴答数据或正在运行的 Pi 进程。

## English

Thank you for contributing.

1. Fork the repository and create a focused branch.
2. Never commit OAuth tokens, Dida365 configuration, real task IDs, logs, session files, or local absolute paths.
3. Run `npm ci` and `npm run check` before opening a PR.
4. Keep the public UX natural-language first; `/todos` is the only public Todo slash command.
5. Preserve the invariant: source work cannot complete before a pending human-acceptance Todo exists.
6. Changes to the domain model, completion semantics, or remote format require tests and documentation updates.
7. Scheduling, recurrence, Poller, or package loading/upgrade changes must also update `docs/operations/recurring-scheduling-and-live-upgrades.md`.
8. OpenClaw, Claude Code, Codex, or other host-adapter work must follow `DEVELOPMENT.md` and `docs/development/multi-cli-adapter-development-guide.md`, including Pi compatibility, isolated namespaces, Turn Grants, and real-host acceptance.
9. PRs should describe the problem, solution, risks, verification, and impact on existing Dida365 data or running Pi processes.
