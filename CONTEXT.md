# Dida Todo

Dida Todo 把 Dida365 项目、顶层工作、执行步骤和人类验收连接到不同 Agent 宿主，同时保持任务生命周期和远端数据语义一致。

## Language

**Todo Engine**:
宿主中立的深模块，拥有 Dida 同步、工作类型、调度、生命周期、验收和并发不变量；它不拥有任何具体 CLI 的 UI、Hook 格式或安装机制。
_Avoid_: Shared plugin, universal extension

**Host Adapter**:
把某个 Agent 宿主的 input、session、turn、tool、finalization、UI 和交付事件翻译成 Todo Engine 事实的适配器。Pi、OpenClaw、Claude Code 和 Codex 各自拥有独立 Host Adapter。
_Avoid_: Compatibility branch, host mode

**Turn Grant**:
宿主在原始输入精确满足队列检查条件时，为一个 adapter、session 和 turn/run 签发的一次性短期队列授权。模型文本或普通 MCP 参数不能自行创建 Turn Grant。
_Avoid_: Permission flag, prompt instruction

**Adapter Namespace**:
用于隔离不同 Host Adapter 的 binding、project provisioning 和执行所有权的身份。相同 cwd 不表示不同 adapter 默认共享同一个 Dida project。
_Avoid_: CLI name suffix

**Shared Project**:
由用户显式选择、允许多个 Host Adapter 访问的同一 Dida project。只有 adapter-aware execution claim 和兼容锁协议存在后，Shared Project 才具备执行资格。
_Avoid_: Same-cwd project

**Degraded MCP Mode**:
仅暴露 Dida 工具、但缺少可信原始输入和 finalization hooks 的接入模式。它可用于受限 mutation，不具备与完整 Host Adapter 相同的队列授权和验收保证。
_Avoid_: Full compatibility
