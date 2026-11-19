---
name: handoff
description: ASD v2.7.0 canonical session handoff skill (`/handoff`, `/asd-handoff`) summarizing conversation history, SQLite state, `progressBoard`, and 3-track routing context into `handoff.md`.
---

# Session Handoff (`/handoff`, `/asd-handoff`)

## Protected `.asd/` Directory & Official CLI-Only Rule

> NEVER directly edit or create files inside `.asd/` (protected by `PreToolUse` hook). ALWAYS use official `asd` CLI commands, and **IMMEDIATELY HALT** if no official CLI command exists.

**Response Language Policy:** Respond in the user's language while preserving exact CLI commands, flags, file paths, task IDs, and JSON keys.

## Step 1: Gather Live State (Read-Only)

1. Generate the redacted baseline via `asd handoff [--output <path>] [--print|-p] [--json]` (or inspect live state via `asd status`).
2. Check `.asd/PLAN.md` and `.asd/sessions/` (read-only) for pending `[ ]`, `[Cross-Scope ...]`, escalated `[~]`, and completed `[x]` tasks, retry/telemetry metrics, `deferredCrossScopeRequests`, and subagent logs.
3. Run `git status --short` and `git log -n 5 --oneline`.

## Step 2: Enrich `handoff.md` in Exact Standard Format

Write `<projectRoot>/handoff.md` (outside `.asd/`, or the `--output <path>` target) by merging the `asd handoff` baseline with conversation context using this exact `HANDOFF CONTEXT` block:

```markdown
# HANDOFF CONTEXT

## USER REQUESTS (AS-IS)
- <verbatim user requests>

## GOAL
<concise session objective>

## WORK COMPLETED
- <completed tasks, modified files, and verified results>

## CURRENT STATE
- **Active ASD Session ID:** <session ID>
- **Execution Track:** <`DIRECT` | `LIGHT` | `HEAVY`>
- **Retry / Telemetry:** <retries, failures, and telemetry summary>
- **progressBoard:** <current `progressBoard` snapshot>
- **Git:** <branch @ SHA and working tree status>
- **Tests:** <latest test run scope and pass/fail status>
- **Multi-Harness Sync:** <`asd sync` status>

## PENDING TASKS
- [ ] <pending tasks>
- [Cross-Scope ...] <`deferredCrossScopeRequests` items>

## KEY FILES
- `<path>` — <purpose/status>

## IMPORTANT DECISIONS
- <`DIRECT` / `LIGHT` / `HEAVY` routing & fallback choices, plus key design decisions>

## EXPLICIT CONSTRAINTS
- <user rules>
- Zero runtime dependencies; Node >=22.13.0 erasable TypeScript

## CONTEXT FOR CONTINUATION
<immediate next step, open blockers, and assumptions to verify>
```

## Step 3: Present Summary

1. Confirm `<projectRoot>/handoff.md` has been saved.
2. Print the current `progressBoard` and a brief continuation summary.
