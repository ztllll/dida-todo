# 使用中立 Core 与隔离 CLI Adapter，不在 Pi 入口内做多宿主分支

dida-todo 的 OpenClaw、Claude Code 和 Codex CLI 支持将采用“一个宿主中立 Todo Engine + 每个 CLI 独立 Adapter/Package”的形态；当前 Pi Extension 保持已验收接口与发布单元，不因其他宿主接入而加入运行时宿主判断。新 Adapter 默认使用独立 binding/project namespace，只有完成 adapter-aware execution claim 后才允许用户显式共享 Dida project。该选择牺牲了单包安装的表面简洁，换取 Pi 行为隔离、宿主生命周期的 locality、独立升级回滚，以及精确口令、settled 收口和验收不变量在每个宿主上的可验证实现。