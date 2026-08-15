# Recurring Scheduling and Live Upgrades

## Supported host

`dida-todo` v0.7.1 supports OMP `17.3.3` Interactive/TUI sessions only. The plugin uses OMP `ExtensionContext` timers and lifecycle events; print, RPC, ACP, Pi, OpenClaw, Claude Code, and Codex CLI are not supported operational surfaces.

No extension logic infers interactive status, host identity, or child-agent identity from prompt text, session files, or paths. The host provides `ctx.hasUI` and the lifecycle context.

## Scheduling semantics

1. Synchronization can discover a recurring task before that occurrence is executable.
2. Priority sorts eligible work; it does not bypass the task-local date/time gate.
3. The poller runs immediately after an interactive binding activates, then every `pollIntervalMinutes` (10 by default), only while OMP is idle and has no pending messages.
4. Exact `检查todo` performs the same queue check immediately. Near matches and ordinary mutations never scan the queue.

### Time gate

For a task using `timeZone`:

- A timed task is eligible only on its scheduled local date and at or after `startDate`; when absent, `dueDate` is the fallback.
- An all-day task is eligible only on its scheduled local date.
- A future occurrence is visible during synchronization but remains ineligible.
- An occurrence discovered after its scheduled date is not automatically backfilled.
- Tasks without a start/due date use their priority normally.

The poller does not create an individual wall-clock timer for each task. A due task is claimed at the next eligible poll or exact queue check.

## Timer ownership and errors

The poller timer is created with `ctx.setInterval()` and cleared with `ctx.clearTimer()`. OMP clears owned timers again during session shutdown. A synchronization error is logged through the OMP extension logger; it does not terminate the timer or grant a queue permission.

Queue execution grants are short-lived and host-issued. The trusted Poller follow-up and exact user input `检查todo` are the only grant sources. Tool arguments, model text, and near-match input cannot mint one.

## OMP plugin upgrade

Install a pinned release:

```bash
omp plugin install github:ztllll/dida-todo#v0.7.1
```
OMP's plugin manager invokes `bun` to resolve plugin dependencies. A standard Bun-based OMP installation already has it; a standalone/prebuilt OMP binary needs Bun `1.3.14+` on `PATH` before this command.


Installation changes the plugin checkout and dependencies but cannot safely replace code currently executing in another host process. Do not upgrade while OMP is mutating a Dida task, finalizing acceptance, provisioning, invoking the bundled CLI, or running work likely to call dida-todo again.

### Safe upgrade procedure

1. Wait for every relevant OMP session to finish its atomic task and become idle.
2. If migrating from Pi, wait for its session to become idle and stop the Pi Runtime. Pi and OMP must not poll or mutate the same Dida project concurrently.
3. Install the pinned OMP plugin ref.
4. Start a new OMP Interactive/TUI session.
5. Run `/todos` and confirm the Dida Overlay/session state is correct.
6. Use one low-risk task to verify exact `检查todo` grants the queue while a normal mutation does not scan it.

Existing Pi metadata, `pi-todo-*` tags, and local configuration/state files are migration inputs. New OMP writes use `WorkMetadata v3`, `dida-todo-*` tags, and `~/.config/omp-dida-todo`. After the first OMP remote mutation, returning to Pi requires an explicit reverse data migration.

## Recovery boundaries

`session_idle` and `agent_end` finalize work only after the source remains eligible. `session_shutdown` is recovery-only: it clears timers, releases local runtime state, and makes a bounded best-effort to recover outstanding acceptance work. A timeout can leave a created acceptance and an unfinished source; the next synchronization reuses the existing acceptance and repairs the sequence.

Cross-host strong consistency and exactly-once mutation are not claimed because the public Dida API provides no confirmed CAS, ETag, or idempotency key. Same-host mutation is serialized with the host lock and atomic local state store.

## English summary

The supported operational surface is OMP `17.3.3` Interactive/TUI. Polling is context-owned, idle-only, and gated by exact `检查todo` or a trusted Poller follow-up. Upgrade only while both OMP and any old Pi host are idle; stop Pi before OMP touches the same Dida project. Verify `/todos`, exact queue execution, and ordinary-mutation non-scanning after installing the pinned plugin.

