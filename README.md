# dida-todo

`dida-todo` 是一个 Pi 扩展：保留原 Todo 工具、`/todos` 和 Overlay 体验，把滴答清单作为持久任务真源，并在每项工作结束后强制创建人类验收 Todo。

## 能力

- 用户在滴答记录顶层工作和 Checklist，LLM 说“检查 Todo”即可同步并执行。
- Pi 和滴答双向同步 Checklist 标题与完成状态。
- Pi Overlay 显示 `pending / in_progress / completed`。
- 支持优先级、时间范围、时区和提醒字段。
- 工作完成时自动生成解决报告与两分钟后的待验收 Todo。
- 人类完成验收 Todo 后闭环；保留未完成并评论时，LLM 下次会读取反馈并先询问。

## 要求

- Node.js `>=20`
- Pi Coding Agent
- 滴答清单账号
- 一个专用于当前项目/工作目标的滴答清单

包内已依赖 `@suibiji/dida-cli`，无需另行全局安装 `dida`。

## 安装

当前尚未发布 npm，可从本地或未来的 GitHub 仓库安装：

```bash
pi install /absolute/path/to/dida-todo
# 发布后：pi install npm:dida-todo
# GitHub 发布后：pi install git:github.com/ztllll/dida-todo@v0.1.0
```

> 必须禁用 `@juicesharp/rpiv-todo` 或任何同时注册 `todo` 工具、`/todos` 命令的扩展。`dida-todo` 启动时会检测冲突并拒绝静默覆盖。

## 滴答登录

安装后运行包内 CLI 登录：

```bash
./node_modules/.bin/dida auth login
```

Pi 通过同一用户配置读取 OAuth 凭据。Token 不应写入仓库。

## 配置

创建：

```text
~/.config/pi-dida-todo/config.json
```

示例：

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "autoResumeSingle": true,
  "bindings": [
    {
      "key": "tmux:my-project:0.0",
      "cwd": "/absolute/path/to/project",
      "projectId": "DIDA_PROJECT_ID",
      "label": "my-project"
    },
    {
      "key": "cwd:/absolute/path/to/project",
      "projectId": "DIDA_PROJECT_ID",
      "label": "my-project"
    }
  ]
}
```

`didaCommand` 是可选高级覆盖；默认使用包内 `@suibiji/dida-cli`。

## 使用

用户界面只保留：

```text
/todos
Ctrl+Shift+T
```

日常直接口述：

```text
检查 Todo
处理高优先级任务
继续上次工作
看看待验收报告
```

内部工具：

- `todo`：操作当前工作 Checklist。
- `todo_work`：LLM 内部同步、切换和完成顶层工作；用户无需调用。

## 数据模型

```text
滴答固定清单
├── 顶层工作任务
│   └── Checklist Items（Pi Todo）
└── 🧑‍🔬 待验收任务
```

工作完成不变量：

```text
全部步骤完成
→ 生成解决报告
→ 创建/复用待验收 Todo 与提醒
→ 创建成功后才完成原工作
```

## 冲突与边界

- 与 `@juicesharp/rpiv-todo` 冲突：二者均注册 `todo` 和 `/todos`，不能同时启用。
- 与 `@narumitw/pi-statusline`、纯主题包、`pi-updater` 无冲突。
- `in_progress` 是 Pi 受管元数据；滴答原生 Checklist 侧显示为未完成。
- 当前不是后台 daemon；滴答负责提醒，用户输入触发 LLM 同步。
- 配置和 OAuth 凭据位于用户目录，不打包、不提交。

## 开发

```bash
npm install
npm run check
```

项目内实验：

```bash
pi --approve --no-extensions -e ./extensions/dida-todo/index.ts
```

## 发布状态

- npm 名称 `dida-todo` 当前可用。
- GitHub 已存在同名的无关仓库，但 `ztllll/dida-todo` 当前可用。
- 尚未创建 GitHub 仓库，也尚未发布 npm；这些是外部发布动作，需要单独确认后执行。

## License

MIT
