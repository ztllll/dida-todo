# dida-todo（dsh 插件）

DeepSeek Harness（dsh）插件：**滴答清单 Todo + 会话中断自动续跑**。源码与 Pi 版本见 [ztllll/dida-todo](https://github.com/ztllll/dida-todo)。

## 它做什么

- **恢复与收尾**：在原会话发任何消息会恢复本会话挂起的工作并勾掉 🙋 提醒；勾掉 / 删除提醒也会在同步时恢复。正常结束仍有未闭合子项时最多补一轮收尾，每条人类消息重置次数；不催促等待人工的工作，不接管子代理，也不开启轮询。

- **中断自动续跑**：回合因 `content_filter`、`429` 限流、`Overloaded` 或进程崩溃结束，且会话还有未完成工作（dsh goal、`todo_write` 清单、或滴答工作）时，等 30s / 1m / 2m / 5m / 10m 后自动让 Agent 继续；被 goal 驱动器停掉的 goal 会先重新激活。你点停止的回合不续跑；你发任何消息都会撤销待发的续跑。
- **转人工提醒**：连续 5 次续跑仍中断，在滴答清单建一条「🙋 需要你处理」（+3/+6 分钟两次提醒），不再无限重试。
- **滴答 Todo**（工作目录已绑定滴答清单时）：新增 `todo` / `todo_work` 工具，多步工作同步到滴答（手机可看），步骤显示在输入框上方的「任务」面板；全部完成后顶层任务自动完成并生成待验收。卡住时 Agent 可 `wait_for_human` 挂起，不会反复刷屏。

- **按会话隔离**：同一项目多个会话互不干扰，每个会话的任务面板只显示自己创建或领取的工作；要接手别的工作，在该会话输入 `检查todo`。

**不替换 dsh 自带功能**：`todo_write`、goal、任务面板全部保留。本插件只新增一行插件和两个工具；未绑定滴答的目录里，Agent 照常用 `todo_write`。停用或卸载后 dsh 恢复原样。

## 安装

在 dsh 侧栏 **插件 → 添加插件**，填：

```text
github:ztllll/dida-todo#v0.9.5
```

或命令行：

```sh
dsh plugin --profile web add "github:ztllll/dida-todo#v0.9.5"
```

安装后在插件页启用（默认启用），刷新页面即生效。不需要构建脚本授权。

已验证的 dsh 版本：0.2.0-rc.2、0.2.1-rc.2。升级 dsh 不会卸载插件，也无需重装。

## 标准 / PTC 模式兼容

`todo` / `todo_work` 同时适用于 dsh 标准（native）与 PTC 模式。PTC 生成工具 SDK 时要求参数定义是无损 JSON；直接传入 TypeBox 对象会因其隐藏元数据触发 `parameters must be lossless JSON before schema projection`。dsh 适配层将两个工具的 TypeBox 参数定义转换为纯 JSON Schema，只剥离 TypeBox 隐藏元数据，保留参数约束。Pi 仍使用原始 TypeBox schema，不修改或放宽 dsh 宿主的严格 JSON 校验。

## 绑定滴答（可选）

只用自动续跑可以跳过。要用滴答 Todo：

1. 登录滴答：`npx @suibiji/dida-cli auth login`（浏览器 OAuth；已在 Pi 版 dida-todo 登录过的机器可跳过）。
2. 把工作目录绑定到一个滴答清单：编辑 `~/.config/pi-dida-todo/config.json`（权限 0600）：

   ```json
   { "bindings": [ { "key": "cwd:/abs/path/to/project", "cwd": "/abs/path/to/project", "projectId": "<滴答清单 ID>", "label": "我的项目" } ] }
   ```

   清单 ID 用 `npx @suibiji/dida-cli project list` 查看。装了 Pi 版的话，在 Pi 里对同一目录 `/dida-bind` 即可，两边共用这份绑定。
3. 重启 dsh（绑定在启动时读取）。

## 配置

在插件页编辑，或在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: dida-todo
  config:
    maxAutoContinue: 5   # 0 关闭续跑
    poll: false          # true：dsh 空闲时也轮询领取滴答任务（同一清单有 Pi 会话时别开）
```

## 卸载

插件页卸载，或：

```sh
dsh plugin --profile web remove dida-todo
```

卸载移除整层配置，dsh 自带的 `todo_write` 与任务面板照常工作。滴答上的历史任务不会被删除；`~/.config/pi-dida-todo` 与 `~/.local/state/pi-dida-todo` 若不再需要可手动删除（Pi 版也在用时请保留）。

## 权限说明

- 插件在 dsh 宿主进程内运行，会以当前用户身份调用 dida CLI 子进程访问滴答 OpenAPI。
- 只读写本机 `~/.config/pi-dida-todo`、`~/.local/state/pi-dida-todo` 与系统临时目录下的锁文件。
- 续跑消息以插件身份追加到会话，不执行任何命令；是否执行由 Agent 在会话原有权限下决定。
