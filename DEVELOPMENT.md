# Development Guide

当前正式功能只支持 Pi。OpenClaw、Claude Code 和 Codex CLI Adapter 尚未实现；本仓库已经准备好第一方研究、架构决策和可执行开发手册，供后续 LLM/开发者接手。

## 多 CLI Adapter 开发入口

按顺序阅读：

1. [README](README.md) — 当前已发布行为与限制
2. [领域词汇](CONTEXT.md) — Todo Engine、Host Adapter、Turn Grant、Adapter Namespace
3. [架构决策](docs/adr/0001-host-neutral-core-with-isolated-cli-adapters.md)
4. [第一方可行性研究](docs/research/2026-08-13-multi-cli-adapter-feasibility.md)
5. [可执行开发手册](docs/development/multi-cli-adapter-development-guide.md)

## 当前基线

```text
Runtime: v0.6.13
Pi automated tests: 178 passed, 1 opt-in real-Dida gate skipped
Recommended first adapter: OpenClaw native plugin
Non-Pi adapters implemented: none
```

## 开始前

```bash
npm ci
npm run check
git diff --check
npm audit --omit=dev
```

禁止直接从“大规模抽 Core”开始。第一条实现 Issue 应是：为 `DidaCliGateway` 写 `ProcessRunner` seam 的红测，并保持 Pi observable behavior 完全不变。

## 不可破坏的边界

- Pi Adapter 的 `todo`、`todo_work`、`dida_todo_setup`、`/todos` 和 Overlay 保持兼容；
- 只有精确 `检查todo` 才授权整队列；
- mutation 不扫描；
- 普通 Poller 保持 no-op；
- 新 Adapter 默认使用独立 Dida project/binding namespace；
- Skill/提示词不能代替 Turn Grant；
- 真实 Dida 测试必须隔离并清理；
- 没有真实宿主验收不得宣称支持。

完整开发、测试、发布和交接流程见[多 CLI Adapter 开发手册](docs/development/multi-cli-adapter-development-guide.md)。
