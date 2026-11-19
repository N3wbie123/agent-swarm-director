---
name: asd-run
description: Execution & resume workflow for ASD v2.7.0 across 3-track DIRECT/LIGHT/HEAVY turns, cross-scope auto-created tasks, and live progress boards.
---

# ASD v2.7.0 — Execution & Resume Workflow (`/asd-run`)

> [!IMPORTANT]
> **Protected `.asd/` Directory & Official CLI-Only Rule**: NEVER directly create, edit, or overwrite any file inside `.asd/` (protected by `PreToolUse` hook). ALWAYS use official `asd` CLI commands (`asd plan`, `asd dispatch`, `asd verify`, `asd debate`, `asd handoff`, `asd status`, `asd clean`); if no official CLI command exists, **IMMEDIATELY HALT** and explain why.

> **Response Language Policy**: Respond and summarize `progressBoard` or tool output in the user's language, while preserving exact CLI commands, flags, file paths, task IDs, and JSON keys.

## 1. 3-Track Execution Criteria (Canonical: `/asd`)

- **`DIRECT`**: 1–3 files sequential directly in the main session (optional `asd-scout` for broad search), gated via `asd verify`.
- **`LIGHT`**: internal `asd-<role>` subagents on synced `routing.jsonc` models; no external CLIs, no worktrees. Same-turn multiple workers MUST run sequentially or have strictly disjoint `targetFiles`.
- **`HEAVY`**: parallel external CLI/ACP tasks in isolated git worktrees (`.asd/wt/<turn>-<taskId>`).

## 2. Execution Protocol (Steps 1–4)

### Step 1: Sync & Assess
1. Sync manual `.asd/PLAN.md` edits into SQLite: `asd plan sync_from_md` (alias `asd plan --from-markdown`).
2. Inspect `progressBoard` and identify the next pending `turn` (treat `[Cross-Scope ...]` tasks as normal work).

### Step 2: Confirm Track
- Unless `DIRECT`, `LIGHT`, or `HEAVY` is already confirmed, recommend one with a brief rationale and wait for user confirmation before dispatching.

### Step 3: Dispatch Current Wave (`turn = N`)
- **`DIRECT`**: Claim with `asd dispatch --turn <N> --mode claim_only`, apply edits directly in the main session within `targetFiles`, then run `asd verify`.
- **`LIGHT`**:
  - **STRICT PROHIBITION**: NEVER pass `--mode parallel_spawn` or invoke external CLI processes (`opencode run`, `claude -p`, `codex exec`, `agy`, `cursor-agent`).
  - Ensure tasks use `track: "LIGHT"` (update and re-run `asd plan sync_from_md` if needed), then run `asd dispatch --turn <N> --mode claim_only`.
  - When multiple workers share a turn, enforce sequential verify-per-task or strictly disjoint `targetFiles`.
  <!-- @harness:opencode -->
  - **OpenCode**: invoke `task` with `subagent_type: "asd-<role>"` (uses synced `~/.config/opencode/agent/asd-<role>.md` model).
  <!-- @end -->
  <!-- @harness:claude-code -->
  - **Claude Code**: invoke `Agent` / `Task` with `subagent_type: "asd-<role>"`.
  <!-- @end -->
  <!-- @harness:antigravity -->
  - **Antigravity**: invoke `invoke_subagent` with `TypeName: "asd-<role>"` and explicit `Model` from `{{LIGHT_SCOUT_MODEL}}`, `{{LIGHT_WORKER_MODEL}}`, `{{LIGHT_PLANNER_MODEL}}`, `{{LIGHT_ARCHITECT_MODEL}}`, `{{LIGHT_CRITIC_MODEL}}` — never `"inherit"`.
  <!-- @end -->
  <!-- @harness:codex -->
  - **Codex**: delegate via native subagent or execute directly within `targetFiles`.
  <!-- @end -->
  <!-- @harness:cursor -->
  - **Cursor**: delegate via native subagent (synced `~/.cursor/agents/asd-<role>.md`) or execute directly within `targetFiles`.
  <!-- @end -->
- **`HEAVY`**:
  <!-- @harness:opencode -->
  - **OpenCode Non-Blocking Rule**: ALWAYS pass `--async` (`asd dispatch --turn <N> --mode parallel_spawn --async`); `asd-guard.js` auto-notifies your session on wave completion (optional wait: `asd status` / `asd wait --timeout 600000`).
  <!-- @end -->
  - **Other Harnesses (default)**: run `asd dispatch --turn <N> --mode parallel_spawn` (optional `--transport <auto|acp|cli>`).

### Step 4: Gate Verification, Cross-Scope & 3-Strike Escalation
1. Run `asd verify --task <T-ID> --cmd "<verifyCmd>"` (or `--file <verify.json>`).
2. Handle cross-scope outputs:
   - `autoCreatedTasks`: max 2 auto-accepted `[Cross-Scope ...]` tasks scheduled for the next turn; display on `progressBoard` and run in the next wave.
   - `deferredCrossScopeRequests`: requests exceeding quota, targeting protected paths, or exceeding depth (with `deferReason`); surface to the user for review.
3. **3-Strike Escalation** on `asd verify` failure:
   - **Strike 1**: fix in-place within `targetFiles` and re-verify.
   - **Strike 2**: raise `thinkingEffort` or invoke `asd-critic`, then re-verify.
   - **Strike 3**: escalate to `HEAVY` `asd debate` or `/asd-debug` and wait for user instructions.
