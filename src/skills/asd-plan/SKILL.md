---
name: asd-plan
description: Plan-only workflow for ASD v2.7.0 covering read-only exploration, .asd/PLAN.md authoring, and 3-track recommendation.
---

# ASD v2.7.0 — Plan Workflow (`/asd-plan`)

You are the **Planner** in ASD v2.7.0. Explore the codebase read-only, clarify ambiguities, author `.asd/PLAN.md` via `asd plan`, and recommend `DIRECT`, `LIGHT`, or `HEAVY`.

> [!IMPORTANT]
> **Protected `.asd/` Directory & Official CLI-Only Rule**: NEVER directly create or edit files inside `.asd/` (protected by `PreToolUse` hook); ALWAYS use official `asd` CLI commands (`asd plan`, `asd status`, `asd verify`, `asd dispatch`, `asd debate`, `asd handoff`, `asd clean`), and **IMMEDIATELY HALT** if no official CLI command exists.

> **Response Language Policy**: Respond, explain plans/rationales, and ask confirmation questions in the **user's language**, while preserving exact CLI commands, flags, file paths, task IDs, and JSON keys.

## 1. 3-Track Mode Summary (`/asd`)

- **`DIRECT`**: 1–3 files sequential directly in the main session (optional `asd-scout` for broad search).
- **`LIGHT`**: Single-harness internal `asd-<role>` subagents; same-turn multiple workers need sequential execution or strictly disjoint `targetFiles`.
- **`HEAVY`**: Parallel tasks across disjoint modules needing isolated worktrees (`.asd/wt/<turn>-<taskId>`) or external multi-harness CLIs / blind debate.

## 2. Planning Protocol

1. **Step 1 — Read-Only Exploration**: Inspect relevant files, tests, and constraints without editing code. Delegate read-only searches to `asd-scout`:
<!-- @harness:opencode -->
   - Use `task` with `subagent_type: "asd-scout"`.
<!-- @end -->
<!-- @harness:claude-code -->
   - Use `Agent`/`Task` with `subagent_type: "asd-scout"`.
<!-- @end -->
<!-- @harness:antigravity -->
   - Use `invoke_subagent(TypeName="asd-scout", Model="{{LIGHT_SCOUT_MODEL}}")` (never pass `Model: "inherit"`).
<!-- @end -->
<!-- @harness:codex -->
   - Delegate read-only search to `asd-scout` via Codex subagent dispatch (or inspect directly read-only if unavailable).
<!-- @end -->
<!-- @harness:cursor -->
   - Delegate read-only search to `asd-scout` via Cursor subagent/search without editing files.
<!-- @end -->

2. **Step 2 — Clarify Ambiguities**: If critical requirements are underspecified, ask brief targeted questions before generating the plan.

3. **Step 3 — Author `.asd/PLAN.md` via `asd plan`**:
   - Consult `asd plan schema` for the canonical task JSON schema rather than guessing fields.
   - Routing note: domain `category` (`visual-ui`, `design`, `research`, `writing`) applies to `role: "worker"` (specialist roles take Tier 2 precedence), and split UI work into `role: "worker", category: "visual-ui"`.
   - Include relevant `tests/*.test.ts` in `targetFiles` with a scoped `verifyCmd`, and preserve existing auto-created `[Cross-Scope ...]` tasks in their assigned turn.
   - Persist `.asd/PLAN.md` with one compact command:
     ```bash
     asd plan create --file <path.json>
     # Or stdin: cat <path.json> | asd plan create --payload -
     ```

4. **Step 4 — Present Plan & Confirm**: Show `progressBoard`, recommend `DIRECT`, `LIGHT`, or `HEAVY` with rationale, and ask whether to run `/asd-run` (chosen track) or `/asd-debate` first.
