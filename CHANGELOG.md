# Changelog

All notable user-visible changes are recorded here. The project is released through pinned GitHub tags and does not publish to npm.

## [Unreleased]

## [0.7.1] - 2026-08-15

### Fixed

- Project internal `in_progress` into a clean human-readable `当前进展` section in the top-level Dida description. Every Checklist create/update mutation immediately refreshes the active action and settled/total count, while preserving the original user description and body exactly once.

### Changed

- Use the human topic name as the default Dida project name and discovery alias. Persisted project IDs remain authoritative, while topic, exact tmux target, and cwd aliases converge changed entry points onto the same project without guessing, merging, or deleting duplicate projects.

### Fixed

- Register Interactive/TUI sessions before activating their Dida binding, so a freshly installed plugin can load `/todos`, the Overlay, and Dida tools instead of rejecting its own `session_start` as inactive.
- Keep Checklist descriptions idempotent across repeated Item creation and status updates, so the preserved task body appears exactly once instead of being appended again on every remote mutation.

## [0.7.0] - 2026-08-14

### Changed

- Replace the Pi package/runtime with the OMP `17.3.3` extension contract. The published plugin declares `omp.extensions`, uses OMP TypeBox/TUI/UI/lifecycle APIs, and supports only Interactive/TUI sessions.
- Preserve OMP-native `todo` and `/todo`. Durable Dida operations are now `dida_todo`, `dida_todo_work`, and `dida_todo_setup`; `/todos` remains the public Dida status command.
- Replace terminal/settled finalization with OMP `session_idle`, `agent_end`, and shutdown recovery; move polling to an `ExtensionContext`-owned timer and use the host lock/local state store for all repository mutation.
- Write `WorkMetadata v3`, `dida-todo-*` tags, OMP-native comments/reminders, and `~/.config/omp-dida-todo` state/configuration. Legacy Pi metadata, tags, local files, and remote records remain migration inputs only.
- Require Chinese semantics for every filled `dida_todo create` field by default. `allowNonChinese: true` is allowed only for an explicitly requested non-Chinese task.

### Verification

- Convert the suite to Bun: 188 passing tests, one opt-in real-Dida test skipped, plus TypeScript verification.


## [0.6.20] - 2026-08-14

### Added

- Add a local `skipped` terminal state for Checklist Items that the user explicitly wants left unchecked or that are not applicable. Skipped Items remain unchecked in Dida, count as settled for queue/finalization purposes, carry a human-readable resolution, and no longer cause the Poller to repeatedly reclaim an already-delivered visual state.

## [0.6.19] - 2026-08-14

### Changed

- Keep Dida-visible titles, descriptions, bodies, Checklist Items, resolutions, progress comments, and acceptance reports strictly human-readable. Agent guidance now forbids chain-of-thought, investigation narration, test scaffolding, prompts, managed JSON, runtime IDs, and lifecycle fields in user-facing task text.
- Move work metadata and acceptance/source/rework links into an atomic same-host JSON state store. Legacy managed blocks in Dida `content`/`desc` remain readable as migration input and are removed from the remote task on synchronization while preserving the user's original description and body.
- Persist promoted Checklist body text as clean human-readable Dida description content, because Dida clears Checklist `content`; the structured original fields remain recoverable from local state without exposing machine data.
- Generate each acceptance report from that source task's own objective and completed results instead of copying the whole queue's final conversation into every acceptance. Legacy acceptances with visible source IDs are migrated to concise per-task reports.

## [0.6.18] - 2026-08-14

### Fixed

- Persist managed metadata for Checklist work in Dida `desc` instead of `content`, because Dida asynchronously clears `content` when a TEXT task is promoted to CHECKLIST. This keeps promoted work readable and completable after server normalization.
- Reconcile Checklist Item IDs from the persisted task after Dida rewrites IDs, while preserving the user's original title, description, body, and Checklist text. Existing content-based managed Checklist work remains readable and migrates on its next mutation.

## [0.6.17] - 2026-08-14

### Changed

- Make the claimed-task contract explicit: every user-created Dida task must expose at least one visible Checklist Item before formal LLM execution, even for a one-step plan. Queue payloads now mark Dida-origin Direct Work with `mustCreateVisibleChecklistStep`, while Pi-origin Direct Work keeps its internal execution-step semantics.
- Document the normalization model: the LLM derives precise actionable Items from the user's top-level title, description, body, and existing Checklist; user-authored Item text is immutable, and LLM-authored Items are appended to the same top-level task.

## [0.6.16] - 2026-08-14

### Fixed

- Promote user-created Dida Direct Work to Checklist Work as soon as the LLM adds execution steps, and migrate previously decomposed active Direct Work on its next mutation. This keeps Dida `items[]` aligned with the TUI instead of hiding the visible step list only inside managed metadata.

## [0.6.15] - 2026-08-14

### Fixed

- Preserve the Poller-issued `current_work_step` tracking grant when its trusted extension follow-up enters the input pipeline, so automatically claimed Direct Work can create execution steps and complete normally.

## [0.6.14] - 2026-08-13

### Changed

- Restore idle automatic claiming for due, unfinished Dida work with priority low/medium/high. The trusted Poller checks immediately on binding activation and every 10 minutes by default, stays silent while Pi is busy or messages are pending, grants only its generated follow-up turn queue access, and continues to skip priority-0 drafts, acceptance-only queues, future work, and expired occurrences.
- Keep exact `检查todo` as the immediate manual trigger while preserving the authorization barrier against LLM-initiated scans, ordinary Todo mutations, and near-match phrases.

### Documentation

- Add a first-party feasibility study for OpenClaw, Claude Code, and Codex CLI. Record the decision to keep the accepted Pi adapter isolated while introducing a future host-neutral Todo Engine, per-host packages, one-time host-scoped Turn Grants, and default per-adapter project namespaces. No non-Pi adapter is implemented or deployed.
- Add `DEVELOPMENT.md` and an executable multi-CLI adapter development guide with repository entry order, module map, target interfaces, per-host hook mappings, TDD phases, security gates, test matrix, issue/PR/handoff templates, and Definition of Done so another LLM can start from verified constraints instead of repeating the research.
- Clarify recurring task scheduling: synchronization can observe a future occurrence, but priority never bypasses the task-local date/time gate. Timed tasks execute only on the scheduled day at or after `startDate` (falling back to `dueDate`); all-day tasks use only the calendar-date gate.
- Document the safe live-upgrade boundary: installing a Git package replaces the shared checkout and dependencies but does not reload existing Pi processes. Busy sessions must become idle before installation and then use `/reload` or a new process.

## [0.6.13] - 2026-08-13

### Fixed

- Scope foreground queue synchronization to the input event's session Runtime instead of whichever TUI session is currently active.
- Restore exact `检查todo` injection for print/RPC and multi-session use without weakening the exact-phrase authorization gate.

### Verification

- 178 default tests passed; one isolated real-Dida candidate test remains opt-in.
- TypeScript, package structure, dry-run packaging, credential scanning, and production dependency audit passed.

## [0.6.12] - 2026-08-13

### Changed

- Require the trimmed user input to equal `检查todo` before scanning or switching the top-level queue.
- Add a second authorization gate to `todo_work list/switch/next/refresh`; Todo mutations and unprivileged `finish_current` no longer scan or switch unrelated work.
- Make the legacy background Poller permanently silent.
- Batch related requirements from one user request into one top-level work, one final response, and one human-acceptance task. Appending a new Item revokes stale ready-for-acceptance state.
- Separate Direct and Checklist title semantics and remove duplicate title/description rendering from the Overlay and `/todos`.
- Require every Pi-created top-level work to choose low/medium/high priority (1/3/5). Reserve priority 0 for user drafts and migrate historical Pi priority-0 work to low under the same-host lock.
- Preserve task text links as untrusted input and document that Dida's public OpenAPI has no native attachment upload/download surface; use the active Telegram/Feishu transport for files.

### Verification

- Real isolated Pi runs confirmed that Todo mutations do not invoke `todo_work`, near-match phrases do not scan, exact `检查todo` injects the queue, and a new Direct work is stored as priority 1 and kind `TEXT`.

## [0.6.11] - 2026-08-12

### Changed

- Namespace newly provisioned Dida projects by hostname and exact IM route when tmuxbot inventory can identify it safely.
- Preserve existing exact bindings without migration or duplicate creation.

## [0.6.10] - 2026-08-12

### Changed

- Separate Direct Work from Checklist Work completion semantics.
- Before completing a Checklist top-level task, reread, complete, and verify all remote Items.

## [0.6.9] - 2026-08-12

### Changed

- Introduce explicit `direct | checklist` work types.
- Keep Direct execution steps in managed metadata instead of remote Dida Checklist Items.

## [0.6.8] - 2026-08-12

### Changed

- Require a durable tracking reason before `todo create` can write remote state.

## [0.6.7] - 2026-08-12

### Fixed

- Move finalization to the settled boundary so additional same-request Items cancel premature acceptance.

## [0.6.6] - 2026-08-12

### Changed

- Allow Pi to append steps to one user Checklist while protecting the user's original Item text and structure.
- Rank executable work high to low while preserving Dida order within the same priority.

## [0.6.5] - 2026-08-12

### Changed

- Materialize acceptance results in two phases and backfill the exact final user-visible response after the agent settles.

## [0.6.4] - 2026-08-12

### Changed

- Gate automatic rework on the Dida comment `userId` matching the system guidance comment author.

## [0.6.3] - 2026-08-12

### Changed

- Use two human-acceptance reminders at completion +3 and +6 minutes.

## [0.6.2] - 2026-08-11

### Fixed

- Inject and display complete top-level title, description, body, and Checklist data instead of reading Item titles alone.

## [0.6.1] - 2026-08-11

### Changed

- Keep the active work's complete Checklist visible in the Overlay until another work or session replaces it.

## [0.6.0] - 2026-08-11

### Changed

- Introduce lifecycle-aware metadata, occurrence-safe finalization, mandatory acceptance, same-host cross-process locks, and real-Dida release validation.

[Unreleased]: https://github.com/ztllll/dida-todo/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/ztllll/dida-todo/releases/tag/v0.7.1
[0.7.0]: https://github.com/ztllll/dida-todo/releases/tag/v0.7.0
[0.6.20]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.20
[0.6.19]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.19
[0.6.18]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.18
[0.6.17]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.17
[0.6.16]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.16
[0.6.15]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.15
[0.6.14]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.14
[0.6.13]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.13
[0.6.12]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.12
[0.6.11]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.11
[0.6.10]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.10
[0.6.9]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.9
[0.6.8]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.8
[0.6.7]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.7
[0.6.6]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.6
[0.6.5]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.5
[0.6.4]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.4
[0.6.3]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.3
[0.6.2]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.2
[0.6.1]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.1
[0.6.0]: https://github.com/ztllll/dida-todo/releases/tag/v0.6.0
