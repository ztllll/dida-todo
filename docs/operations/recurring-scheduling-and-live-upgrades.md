# 循环任务调度与运行中升级 / Recurring Scheduling and Live Upgrades

本文固定两个容易混淆的运维边界：

1. **同步发现循环任务，不等于任务已经具备执行资格**；
2. **安装新版 Pi Package，不等于已运行的 Pi 进程自动加载新版 Runtime**。

---

## 中文

### 循环任务执行门

一个顶层任务只有同时满足以下条件，才进入可执行队列：

1. `priority > 0`；
2. 顶层任务尚未完成；
3. 当前 occurrence 仍有未完成工作，或仍需显式完成顶层目标；
4. 任务自己的日期/时间门已经打开。

优先级只负责排列**已经通过时间门**的任务，不能绕过日期或时间限制。

#### 日期与时间规则

有效计划时间为：

```text
startDate ?? dueDate
```

日历日期按任务的 `timeZone` 判断；任务没有时区时才回退 UTC。

- 没有计划时间：满足其他执行门后立即具备资格。
- 全天任务（`isAllDay=true`）：计划日期必须是任务时区下的今天。
- 非全天任务（`isAllDay=false`）：计划日期必须是今天，并且当前时间不得早于计划时间。
- 计划日期已经过去：跳过；dida-todo 不自动补跑错过的 occurrence。
- 计划日期在未来：可以在同步数据中被发现，但不会进入执行队列。
- 时间字符串无效：时间门拒绝放行。

以每天 10:00 的非全天循环任务为例：

| 显式检查时间 | 能否同步发现 | 能否执行 |
| --- | --- | --- |
| 前一天，滴答已推进到明天 10:00 | 是 | 否 |
| occurrence 当天 09:59 | 是 | 否 |
| occurrence 当天 10:00 或之后 | 是 | 是 |
| 第二天才检查遗漏的 occurrence | 是 | 否，不自动补跑 |

本意为 10:00 执行的任务必须设置为非全天。若错误设置成全天任务，系统只检查日期，当天第一次显式检查就可能在 10:00 前执行。

### 显式检查，不是后台闹钟

旧 Poller 永久 no-op，不会：

- 创建 timer；
- 后台读取滴答；
- 到达计划时间时唤醒 LLM；
- 记住一次提前检查并在未来自动发车。

只有用户输入 trim 后完整等于：

```text
检查todo
```

才授权扫描顶层队列。因此提前检查可以发现但过滤未来 occurrence；到达计划时间后仍需再次输入精确口令。

当前语义是：

```text
到达计划时间 + 下一次精确检查 → 进入执行队列
```

不是：

```text
提前发现 → 注册 timer → 到点自动执行
```

如果未来需要无人值守定时执行，应单独设计“用户显式授权、限定 route/任务”的 Scheduler；不能通过恢复扫描所有普通 Todo 的宽泛 Poller 实现。

### 循环 occurrence 隔离

任务存在 `repeatFlag` 时，dida-todo 使用当前 `startDate ?? dueDate` 作为 occurrence key。Execution claim、finalization 和验收关联都绑定该 occurrence。

因此：

- 完成今天的实例不能误完成明天的实例；
- 滴答推进日期后，下一 occurrence 必须重新 claim；
- 陈旧的 completed Checklist 不会导致连续自动收口；
- 每个 occurrence 都有独立验收关联；
- 顶层 priority 会保留，但不会让未来 occurrence 提前执行。

### Pi 运行期间安装新版

Git Pi Package 通常安装到共享目录：

```text
~/.pi/agent/git/github.com/ztllll/dida-todo
```

按 Pi Package 生命周期，执行：

```bash
pi install git:github.com/ztllll/dida-todo@NEW_VERSION
```

会更新 settings、将共享 checkout reset/clean 到新 ref，并在存在 `package.json` 时运行 `npm install`。

已经运行的 Pi 进程不会自动替换内存中的扩展 Runtime；它必须执行 `/reload` 或启动新进程/新会话才会加载新代码。

如果在旧进程执行任务时安装，就可能形成不受支持的混合状态：

```text
旧扩展模块与旧内存 Runtime
+ 新磁盘文件、新 CLI Adapter、新 node_modules
```

安装程序通常不会主动杀死旧 Pi，所以不一定立刻中断模型输出；但后续工具调用、子进程启动、懒加载或依赖解析可能读取已经被替换的安装目录，无法保证任务安全持续执行。

#### 安全升级步骤

1. 等待所有使用 dida-todo 的 Pi 完成当前原子任务、测试、远端写入和最终回复。
2. 确认相关 pane 已 idle，且没有待处理 steering 消息。
3. 安装固定版本：

   ```bash
   pi install git:github.com/ztllll/dida-todo@VERSION
   ```

4. 对每个已运行 Pi 执行 `/reload`，或替换为新进程/新会话。
5. 使用 `/todos` 或隔离 smoke test 验证后，再依赖新版本执行真实任务。

#### 禁止的升级时机

当绑定的 Pi 正在进行以下动作时，不要覆盖共享安装目录：

- 修改 Todo/Checklist；
- 收口工作或创建验收；
- provisioning 项目；
- 调用包内 Dida CLI；
- 执行长任务且后续步骤可能调用 dida-todo。

“只安装、不 reload”只能作为**所有相关进程已经 idle 后**的分阶段部署，不能升级存量进程的内存 Runtime。

---

## English

### Recurring task execution gate

A top-level task enters the executable queue only when all of these conditions are true:

1. `priority > 0`;
2. the top-level task is unfinished;
3. the current occurrence still has unfinished work or needs explicit top-level completion;
4. the task-local date/time gate is open.

Priority only ranks tasks that have already passed the schedule gate. It never bypasses the date or time.

The effective timestamp is `startDate ?? dueDate`, interpreted with the task's `timeZone` for calendar-day comparison.

- No timestamp: eligible immediately after the other gates pass.
- All-day task: eligible only on its scheduled local calendar day.
- Timed task: eligible only on that local day at or after its scheduled timestamp.
- Past day: skipped without automatic backfill.
- Future day/time: visible to synchronization but excluded from execution.
- Invalid timestamp: rejected.

An early exact check does not register a timer. The legacy Poller is permanently no-op: it does not read Dida365 in the background, create timers, wake the LLM, or remember an early scan. Execution requires another exact `检查todo` at or after the scheduled time.

Current behavior is:

```text
scheduled time reached + next exact queue check -> executable
```

not:

```text
early discovery -> timer registration -> automatic execution
```

For recurring tasks, the current `startDate ?? dueDate` forms the occurrence key. Claims, finalization, and acceptance matching are occurrence-scoped, so one completed occurrence cannot finalize the next one.

### Installing while Pi is running

A Git Pi Package uses a shared checkout such as:

```text
~/.pi/agent/git/github.com/ztllll/dida-todo
```

Installing a new ref updates settings, resets/cleans that checkout, and reinstalls dependencies. An already-running Pi process keeps its old in-memory extension Runtime until `/reload` or process replacement.

Installing while old code is actively executing can therefore create an unsupported mixed state: old in-memory code plus new files, CLI adapter, and dependencies on disk. The installer normally does not kill the Pi process, but subsequent tool calls or subprocesses may observe the replaced checkout, so uninterrupted behavior is not guaranteed.

Safe procedure:

1. let every relevant Pi finish its current atomic task and become idle;
2. install the pinned release;
3. `/reload` every existing process or start new processes;
4. run `/todos` or an isolated smoke test before using the new version.

Do not replace the shared checkout while a process is mutating Todo state, finalizing acceptance, provisioning, invoking the bundled Dida CLI, or executing a long task that may call dida-todo later.
