---
name: asd-debate
description: ASD v2.7.0 adversarial debate workflow supporting internal LIGHT critique and cross-harness HEAVY blind debate with binding synthesis.
---

> **Protected `.asd/` Directory & Official CLI-Only Rule**: NEVER directly edit or create files inside `.asd/` (protected by `PreToolUse` hook); ALWAYS use official `asd` CLI commands, and **IMMEDIATELY HALT** if no official CLI command exists.
> **Response Language Policy**: Respond in the user's language while preserving exact CLI commands, flags, file paths, task IDs, and JSON keys.

## 1. Debate Modes (`/asd`)

| Mode | Mechanism | When to Use |
| :--- | :--- | :--- |
| **`LIGHT`** | **Internal Subagent Debate**: fast adversarial critique inside the current harness via `asd-critic` (+ `asd-architect` for binding arbitration) on synced `routing.jsonc` models — no external CLI spawns. | Routine designs, scoped refactors, or quick validation within the active harness. |
| **`HEAVY`** | **Multi-Harness Cross-CLI Blind Debate**: `asd debate` CLI across `claude`, `opencode`, `codex`, `agy`, `agent`/`cursor-agent`. | High-risk architecture, security boundaries, or irreversible migrations requiring cross-model diversity. |

## 2. Debate Protocol

### Step 1 — Frame Proposal, Mode & Participants
1. State **Topic**, **Proposal**, key files, and trade-offs; confirm `LIGHT` vs `HEAVY`.
2. When `HEAVY` is chosen or recommended, ask the user how to assign reviewers unless already specified:
   - **1. User-specified**: `--harnesses <list>` + `--count <2-5>`
   - **2. Auto-assign**: AI autonomous selection, or role-based `--roles <list>` from `routing.jsonc`

### Step 2 — Execute Debate

**`LIGHT` Mode** — Strictly forbid running `asd debate` CLI; invoke native internal `asd-critic` (and `asd-architect` on conflict/`REJECT`):
<!-- @harness:opencode -->
Use `task(subagent_type="asd-critic", ...)` for critique; escalate conflicts or `REJECT` to `task(subagent_type="asd-architect", ...)`.
<!-- @end -->
<!-- @harness:claude-code -->
Use `Agent`/`Task` with `subagent_type: "asd-critic"` for critique; escalate conflicts or `REJECT` with `subagent_type: "asd-architect"`.
<!-- @end -->
<!-- @harness:antigravity -->
Use `invoke_subagent(TypeName="asd-critic", Model="{{LIGHT_CRITIC_MODEL}}", ...)` for critique; escalate conflicts or `REJECT` via `invoke_subagent(TypeName="asd-architect", Model="{{LIGHT_ARCHITECT_MODEL}}", ...)` (never `"inherit"`).
<!-- @end -->
<!-- @harness:codex -->
Invoke internal subagent `asd-critic` for critique; escalate conflicts or `REJECT` to `asd-architect`.
<!-- @end -->
<!-- @harness:cursor -->
Invoke internal subagent `asd-critic` for critique; escalate conflicts or `REJECT` to `asd-architect`.
<!-- @end -->

Require this exact structured JSON verdict:
```json
{
  "verdict": "APPROVE | MINOR_AMEND | REJECT",
  "decisions": ["..."],
  "hard_constraints": ["..."],
  "risks": ["..."],
  "reasoning": "...citing file:line"
}
```

**`HEAVY` Mode** — Run `asd debate` CLI with `--files "path[:start-end],..."` and/or `--diff`, plus `--file <debate.json>` or `--topic "<topic>" --proposal-file proposal.md` for cross-platform safety. When debating a planned task, pass `--task <taskId>` (alias `--task-id <taskId>`) to auto-inject non-`REJECT` constraints/decisions into `tasks.acceptance` and `.asd/PLAN.md`:
```bash
asd debate --file <debate.json> --files "path[:start-end],..." --diff --harnesses "<h1,h2>" --count 3 --task <taskId>
asd debate --topic "<topic>" --proposal-file proposal.md --files "path[:start-end],..." --roles "critic,architect,planner" [--task <taskId>]
```

### Step 3 — Apply Verdict
- **`APPROVE`**: Proceed with implementation and render `progressBoard`.
- **`MINOR_AMEND`**: If `HEAVY` ran with `--task` / `--task-id`, `hard_constraints` and `decisions` are already auto-injected into `tasks.acceptance` and `.asd/PLAN.md` (do not duplicate via `asd plan`); for `LIGHT` mode or taskless `HEAVY` debates, incorporate them via `asd plan`, then proceed.
- **`REJECT`**: Halt (`tasks.acceptance` and `.asd/PLAN.md` are left untouched), revise the proposal to address blocking `risks`, and re-confirm with the user.
