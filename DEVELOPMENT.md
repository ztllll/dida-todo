# Development Guide

`dida-todo` v0.7.0 is an [OMP Agent](https://omp.sh) extension. The supported runtime is OMP `17.3.3` Interactive/TUI; print, RPC, ACP, Pi, OpenClaw, Claude Code, and Codex integrations are not supported release surfaces.

## Runtime contract

- `package.json` declares `omp.extensions: ["./extensions/dida-todo"]`, OMP peer ranges `>=17.3.3 <18`, and a local Bun `1.3.14` test runner.
- The extension never shadows OMP-native `todo` or `/todo`. Its durable tools are `dida_todo`, `dida_todo_work`, and `dida_todo_setup`; `/todos` and the Overlay are the public Dida surfaces.
- Initialization, provisioning, polling, rendering, and setup are gated to an Interactive/TUI session with `ctx.hasUI`. No host or child-agent identity is inferred from prompts, paths, or session text.
- All new work writes `WorkMetadata v3` and `dida-todo-*` tags. v1/v2 metadata and `pi-todo-*` tags are read-only migration inputs; synchronization rewrites them to the v3/local-state form.
- New Dida creation text is Chinese by default. Set `allowNonChinese: true` only when the user explicitly requests non-Chinese content.

## Local workflow

```bash
npm ci
npm run check
git diff --check
npm audit --omit=dev
```

`npm test` resolves the repository-local Bun binary installed by `npm ci`; do not assume a global Bun installation.
This local Bun fallback does not satisfy OMP's plugin manager: `omp plugin install` invokes a `bun` executable from `PATH`. Standard Bun-based OMP installations already have it; standalone/prebuilt OMP binaries need Bun `1.3.14+` installed on `PATH`.


## Non-negotiable behavior

- Only exact `检查todo` grants a full queue check; ordinary mutations and near matches do not scan.
- Polling runs only while the OMP interactive session is idle and has no pending messages. Its timer is owned by `ExtensionContext` and is cleared on shutdown.
- Repository mutation uses the same-host lock and atomic local state. Do not add a second lock implementation or reintroduce global process state.
- The finalization path is `session_idle` / `agent_end` plus `session_shutdown` recovery. Do not revive terminal-event or settled-finalization hooks.
- Human-visible task text contains only objective, action, result, and acceptance evidence; it never contains prompts, thought process, metadata, identifiers, or lifecycle internals.
- Real Dida tests remain opt-in, isolated, and cleanup their temporary project/tasks.

## Release verification

Before tagging, run the complete check command, inspect the packed files, and load the tagged plugin in an isolated OMP profile. Verify `/todo` remains native, `/todos` shows Dida state, exact `检查todo` grants the queue, ordinary mutations do not scan, and no Pi process polls the same Dida project concurrently.

