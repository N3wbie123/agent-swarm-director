---
name: asd-debug
description: ASD v2.7.0 hypothesis-driven debugging workflow to reproduce, diagnose, fix, and verify failures across DIRECT, LIGHT, and HEAVY tracks.
---

> **Protected `.asd/` Directory & Official CLI-Only Rule:** NEVER directly edit or create files inside `.asd/` (protected by `PreToolUse` hook); ALWAYS use official `asd` CLI commands, and `IMMEDIATELY HALT` if no official CLI command exists.

**Response Language Policy:** Respond in the user's language while preserving exact CLI commands, flags, file paths, task IDs, and JSON keys.

## 1. 3-Track Debugging Criteria
Select or escalate the debugging track per `/asd` boundaries:
- **`DIRECT`**: Obvious, localized 1–3 file failure reproduced and fixed directly in the main session + regression test.
- **`LIGHT`**: Localized bug needing read-only log/code tracing (`asd-scout`), hypothesis critique (`asd-critic`), and minimal fix (`asd-worker`) via internal subagents (no external CLIs).
- **`HEAVY`**: 3-Strike escalation after failed local hypotheses or cross-cutting concurrency/architecture bug requiring external cross-harness `asd debate`.

## 2. Debugging Protocol

### Step 1: Reproduce First & Gather Evidence
1. Identify the failing command, stack trace, or task log in `.asd/sessions/` and reproduce deterministically before editing code.
2. When tracing is needed, delegate read-only tracing to `asd-scout`:
<!-- @harness:opencode -->- Invoke `task` with `subagent_type: "asd-scout"` for read-only log/code tracing and `file:line` isolation.<!-- @end -->
<!-- @harness:claude-code -->- Run `Agent(subagent_type="asd-scout")` for read-only log/code tracing and `file:line` isolation.<!-- @end -->
<!-- @harness:antigravity -->- Call `invoke_subagent(TypeName="asd-scout", Model="{{LIGHT_SCOUT_MODEL}}")` (never `"inherit"`) for read-only log/code tracing and `file:line` isolation.<!-- @end -->
<!-- @harness:codex -->- Spawn `asd-scout` sub-agent (read-only) for log/code tracing and `file:line` isolation.<!-- @end -->
<!-- @harness:cursor -->- Launch `asd-scout` subagent (read-only) for log/code tracing and `file:line` isolation.<!-- @end -->

### Step 2: Hypothesize & Confirm Track
List the top 1–3 root-cause hypotheses with `file:line` citations, minimal fix + regression test plan, recommend `DIRECT` / `LIGHT` / `HEAVY`, and ask for confirmation.

### Step 3: Execute Diagnosis & Fix (3-Strike Escalation)
- **`DIRECT`**: Apply minimal fix + regression test directly within `targetFiles`.
- **`LIGHT`**: Strictly no external CLI spawn. Optionally challenge hypothesis via internal `asd-critic` and apply minimal fix via `asd-worker`:
<!-- @harness:opencode -->- Invoke `task` with `subagent_type: "asd-critic"` (optional), then `subagent_type: "asd-worker"` scoped to `targetFiles` + regression test.<!-- @end -->
<!-- @harness:claude-code -->- Run `Agent(subagent_type="asd-critic")` (optional), then `Agent(subagent_type="asd-worker")` scoped to `targetFiles`.<!-- @end -->
<!-- @harness:antigravity -->- Call `invoke_subagent(TypeName="asd-critic", Model="{{LIGHT_CRITIC_MODEL}}")` (optional), then `invoke_subagent(TypeName="asd-worker", Model="{{LIGHT_WORKER_MODEL}}")` (never `"inherit"`) scoped to `targetFiles`.<!-- @end -->
<!-- @harness:codex -->- Spawn `asd-critic` (optional), then `asd-worker` sub-agents scoped to `targetFiles` + regression test.<!-- @end -->
<!-- @harness:cursor -->- Launch `asd-critic` (optional), then `asd-worker` subagents scoped to `targetFiles` + regression test.<!-- @end -->
- **`HEAVY`**: Run `asd debate` with failure evidence and competing hypotheses, then dispatch the verified fix.
- **3-Strike Escalation**: Strike 1 (in-place fix) → Strike 2 (raise `thinkingEffort` or invoke `asd-critic`) → Strike 3 (escalate to `HEAVY` `asd debate`).

### Step 4: Gate Verification
Run `asd verify --task <T-ID> --cmd "<repro_and_regression_cmd>"`, confirm zero regressions, surface `autoCreatedTasks`/`deferredCrossScopeRequests`, and render the updated `progressBoard`.
