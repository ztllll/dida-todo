# 安全策略 / Security Policy

## 中文

请通过 GitHub Security Advisories 私下报告安全问题。不要在公开 Issue 中粘贴：

- 滴答 OAuth Token 或认证配置
- 真实清单、任务和评论内容
- 本地绝对路径、日志或 Pi 会话文件

本扩展以当前用户权限执行依赖中的 Dida CLI。建议：

- 使用专用滴答清单；
- 明确配置 tmux/cwd 绑定；
- 安装前审查源码；
- 不与另一个 `todo`/`/todos` 提供者同时启用；
- 定期检查用户配置文件权限。

## English

Report security issues privately through GitHub Security Advisories. Do not post OAuth tokens, real Dida365 data, local paths, logs, or Pi session transcripts in public Issues.

The extension executes the bundled Dida CLI with the current user's permissions. Use a dedicated Dida365 project, configure exact tmux/cwd bindings, review source before installation, avoid duplicate `todo`/`/todos` providers, and protect user configuration files.
