# Dida Todo OMP Extension

`dida-todo` v0.7.1 connects OMP Agent Interactive/TUI sessions to Dida365. Dida is the durable task source of truth; the local OMP runtime only caches current session state, metadata, bindings, and acceptance links.

## Supported surface

- OMP `17.3.3` Interactive/TUI main sessions only.
- OMP-native `todo` and `/todo` remain untouched.
- Dida tools: `dida_todo`, `dida_todo_work`, and `dida_todo_setup`.
- Public Dida surfaces: `/todos` and the Ctrl+Shift+T Overlay.
- Print, RPC, ACP, Pi, OpenClaw, Claude Code, and Codex CLI are not supported release surfaces.

The extension gates setup, provisioning, polling, rendering, and mutation to `ctx.hasUI`. It never guesses session type or agent identity from prompt text, paths, or session content.

## Work model

```text
Fixed Dida project
├── Top-level work task
│   └── Checklist Items (Dida execution steps)
└── Human acceptance task (report, reminders, feedback entry point)
```

User-created Dida work keeps its original shape until claimed. Formal execution requires at least one visible Checklist Item, even for a one-step plan. User-authored Items are immutable except for status; the Agent may append precise new Items. `skipped` settles an intentionally unchecked/not-applicable Item locally while leaving it unchecked in Dida.

All newly created or appended Dida text uses Chinese semantics by default. Every filled `subject`, title, description, or body field must contain Chinese. Set `allowNonChinese: true` only when the user explicitly requires non-Chinese content; retain Chinese action and goal wording around proper nouns and code identifiers whenever possible.

## Queue and tools

`dida_todo` manages Checklist Items in the selected work:

```text
create / update / list / get / delete / clear
```

Every `create` requires a current-user-authorized `trackingReason`. A new work also requires `workType` and `workPriority`. `current_work_step` is valid only while appending to the active work.

`dida_todo_work` manages top-level work:

```text
list / switch / next / refresh / finish_current
```

Only exact user input `检查todo` or a trusted idle Poller follow-up grants queue operations (`list`, `switch`, `next`, `refresh`). Normal mutations and near matches do not scan the queue. `finish_current` without a queue grant only finalizes the current work; it never selects a new one.

`dida_todo_setup` supports `login`, `auto`, and `bind`. It opens the bundled Dida CLI OAuth flow and immediately provisions/activates the current OMP session.

## Polling and finalization

The OMP context owns the polling timer. It starts after an interactive binding activates, repeats every `pollIntervalMinutes` (10 by default), and runs only while OMP is idle with no pending messages. Eligible work must have priority above zero and pass its task-local date/time gate. A timed task runs on the scheduled local day at or after `startDate` (falling back to `dueDate`); an all-day task runs only on the scheduled day. Future and expired occurrences are not automatically executed.

Human acceptance is a Repository invariant. `session_idle` and `agent_end` finalize only a still-eligible work after its Checklist and whole-objective completion conditions are met. The extension creates/reuses an acceptance task, writes feedback guidance, then completes the source task. `session_shutdown` is recovery-only and bounded; the next synchronization repairs any partial acceptance sequence.

## Storage and migration

- Configuration: `~/.config/omp-dida-todo/config.json`
- Local work state: `~/.local/state/omp-dida-todo/work-state.json`
- New remote metadata: `WorkMetadata v3` and `dida-todo-*` tags
- Legacy migration inputs: Pi v1/v2 metadata, `pi-todo-*` tags, and old local paths

The first OMP remote mutation converts legacy remote records to the current form. Stop the old Pi Runtime before OMP polls or mutates the same Dida project. After OMP writes remotely, rolling back to Pi requires an explicit reverse data migration.

## Installation and verification

```bash
omp plugin install github:ztllll/dida-todo#v0.7.1
npm ci
npm run check
```
`omp plugin install` invokes `bun`; standalone/prebuilt OMP binaries need Bun `1.3.14+` on `PATH`. The repository's `npm ci` workflow supplies a local Bun binary only for development and test commands.


For a plugin upgrade, wait until OMP and any old Pi process are idle, stop Pi, install the pinned ref, start a new OMP Interactive/TUI session, run `/todos`, then confirm exact `检查todo` on one low-risk task. Also confirm that a normal mutation does not scan the queue.

The opt-in real-Dida candidate test requires a temporary dedicated project through `DIDA_TODO_REAL_PROJECT_ID`; it must never point at user work or production routes.

