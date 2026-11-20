---
name: asd
description: ASD v2.7.0 universal autonomous workflow orchestrator supporting DIRECT, LIGHT, and HEAVY tracks across 5 harnesses.
---

> **Protected `.asd/` Directory & Official CLI-Only Rule**: NEVER directly create, edit, or overwrite files inside `.asd/` (enforced by `PreToolUse` hook). ALWAYS use official `asd` CLI commands (`asd plan|dispatch|verify|debate|handoff|status|clean`), and **IMMEDIATELY HALT** if no official CLI command exists.

**Response Language Policy**: Respond in the user's language while preserving exact CLI commands, flags, file paths, task IDs, and JSON keys.

## 1. The 5 Core Roles

| Role | Responsibility | Default Focus |
| :--- | :--- | :--- |
| `planner` | Task decomposition, wave planning, risk triage | Plans & acceptance criteria |
| `architect` | System design, API/schema contracts, boundaries | Architecture & cross-module invariants |
| `worker` | Scoped implementation, bug fixes, refactoring, tests | Idiomatic code & `targetFiles` compliance |
| `scout` | Read-only codebase/docs exploration & symbol tracing | Fast, zero-mutation context gathering |
| `critic` | Post-edit review, edge-case & regression auditing | Verification & failure root-cause critique |

## 2. 3-Track Mode Classification

- **`DIRECT`**: 1–3 files, sequential changes executed directly by the main session (zero subagent spawn overhead; optional `asd-scout` for broad read-only search). Gate via `asd verify`.
- **`LIGHT`**: Single-harness internal `asd-<role>` subagents on synced `routing.jsonc` models (no external CLI spawns, no worktrees). Same-turn multiple `worker` tasks MUST run sequentially or have strictly disjoint `targetFiles`.
- **`HEAVY`**: Multi-harness external CLI/ACP + isolated git worktrees (`.asd/wt/<turn>-<taskId>`) for parallel disjoint subsystems or cross-model blind debate.

## 3. Execution Protocol

### Step 1: Discovery
Inspect the repository and `.asd/PLAN.md` (via `asd status` or `asd plan get`). Delegate broad read-only exploration to `asd-scout`:
<!-- @harness:opencode -->- Invoke `task` with `subagent_type: "asd-scout"`.<!-- @end -->
<!-- @harness:claude-code -->- Invoke `Agent` / `Task` with `subagent_type: "asd-scout"`.<!-- @end -->
<!-- @harness:antigravity -->- Call `invoke_subagent(TypeName="asd-scout", Model="{{LIGHT_SCOUT_MODEL}}")` (never `"inherit"`).<!-- @end -->
<!-- @harness:codex -->- Delegate read-only exploration to the `asd-scout` subagent or run targeted local search.<!-- @end -->
<!-- @harness:cursor -->- Delegate read-only exploration to the `asd-scout` subagent or run targeted local search.<!-- @end -->

### Step 2: Plan
Run `asd plan schema` for the full schema. Create or update the plan via `asd plan create --file <path.json>` or stdin (`--payload -`):
```bash
asd plan create --payload - <<'EOF'
{"tasks":[{"taskId":"T1.1","turn":1,"title":"<Task>","track":"DIRECT","role":"worker","category":"general","difficulty":"low","targetFiles":["src/app.ts","tests/app.test.ts"],"verifyCmd":"npm test"}]}
EOF
```
Note: Domain `category` applies to `role: "worker"` (specialist roles take Tier 2 precedence); always include relevant test files in `targetFiles`.

### Step 3: User Confirmation Gate
Present the plan summary, recommend `DIRECT`, `LIGHT`, or `HEAVY` (plus optional `/asd-debate` for high-risk decisions), and wait for explicit user confirmation.

### Step 4: Wave Execution Loop
- **`DIRECT`**: Claim via `asd dispatch --turn <N> --mode claim_only`, edit directly within `targetFiles`, then gate each task with `asd verify --task <T-ID>`.
- **`LIGHT`**: Strictly forbid external CLI spawns. Run `asd dispatch --turn <N> --mode claim_only`, enforce sequential execution or strictly disjoint `targetFiles` across concurrent `worker` tasks, invoke internal `asd-<role>` subagents, and gate each task with `asd verify --task <T-ID>`:
<!-- @harness:opencode -->  - Invoke `task` with `subagent_type: "asd-<role>"`.<!-- @end -->
<!-- @harness:claude-code -->  - Invoke `Agent` / `Task` with `subagent_type: "asd-<role>"`.<!-- @end -->
<!-- @harness:antigravity -->  - Call `invoke_subagent(TypeName="asd-<role>", Model="<model>")` using synced models: `scout={{LIGHT_SCOUT_MODEL}}`, `worker={{LIGHT_WORKER_MODEL}}`, `planner={{LIGHT_PLANNER_MODEL}}`, `architect={{LIGHT_ARCHITECT_MODEL}}`, `critic={{LIGHT_CRITIC_MODEL}}` (never `"inherit"`).<!-- @end -->
<!-- @harness:codex -->  - Spawn internal `asd-<role>` subagent on its synced `routing.jsonc` model.<!-- @end -->
<!-- @harness:cursor -->  - Spawn internal `asd-<role>` subagent on its synced `routing.jsonc` model.<!-- @end -->
- **`HEAVY`**: Dispatch isolated worktree workers (auto-verified per task; run `asd verify --task <T-ID>` for manual re-checks):
<!-- @harness:opencode -->  - MUST pass `--async`: `asd dispatch --turn <N> --mode parallel_spawn --async` (`asd-guard.js` auto-notifies on completion).<!-- @end -->
<!-- @harness:claude-code -->  - Run `asd dispatch --turn <N> --mode parallel_spawn`.<!-- @end -->
<!-- @harness:antigravity -->  - Run `asd dispatch --turn <N> --mode parallel_spawn`.<!-- @end -->
<!-- @harness:codex -->  - Run `asd dispatch --turn <N> --mode parallel_spawn`.<!-- @end -->
<!-- @harness:cursor -->  - Run `asd dispatch --turn <N> --mode parallel_spawn`.<!-- @end -->
- **3-Strike Verification Failure Escalation**:
  - **Strike 1**: In-place fix within `targetFiles` and re-run `asd verify`.
  - **Strike 2**: Raise `thinkingEffort` or invoke `asd-critic` for root-cause critique, fix, and re-verify.
  - **Strike 3**: Escalate to `HEAVY` `asd debate` or halt with a structured failure summary.

### Step 5: Cross-Scope Requests
- **`autoCreatedTasks`**: Max 2 per task, scheduled for the next turn; enforce `targetFiles` boundaries.
- **`deferredCrossScopeRequests`**: Do not edit out-of-scope files; record and surface them to the user.

### Step 6: Final Summary
Present the final `progressBoard`, verified tasks and files, verification/telemetry summary, and any `deferredCrossScopeRequests`.
