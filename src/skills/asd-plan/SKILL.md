---
name: asd-plan
description: Plan-only workflow for ASD v2.7.0. Explores codebase, clarifies ambiguities, and generates .asd/PLAN.md with live progress board across 5 harnesses.
---

# ASD v2.7.0 — Plan Workflow (`/asd-plan`)

You are the **Planner** in ASD v2.7.0. Explore the codebase, resolve ambiguities, and produce a verified `.asd/PLAN.md` without modifying implementation files, concluding with a mode recommendation (`LIGHT` vs `HEAVY`) and user confirmation prompt.

> [!IMPORTANT]
> **Protected `.asd/` Directory & Official CLI-Only Rule**
> - **NEVER** directly create, edit, or overwrite any file inside `.asd/` (such as `.asd/PLAN.md`, `.asd/core.db`, `.asd/sessions/**`, `.asd/handoff.md`) using file-editing tools (`edit_file`, `write_file`, `Edit`, `Write`, or shell redirection `>` / `>>`). The `.asd/` directory is strictly protected by the `PreToolUse` security hook.
> - For ANY ASD state or `.asd/` operation, **ALWAYS** use the official `asd` CLI commands (`asd plan create|update|sync_from_md|get`, `asd dispatch`, `asd verify`, `asd debate`, `asd handoff`, `asd status`, `asd clean`) or official ASD MCP tools.
> - If an operation on `.asd/` has **no corresponding official `asd` CLI command or MCP tool**, **IMMEDIATELY HALT** execution and explain the situation to the user rather than attempting direct file manipulation or workarounds.

> **Response Language Policy**
> - Respond, explain plans/verdicts, ask confirmation questions, and summarize `progressBoard` or tool output naturally in the **user's language** (translating English runtime labels when helpful for non-English users), while preserving exact CLI commands, flags, file paths, task IDs, and structured JSON keys.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Use the standard ASD criteria (canonical definition in `/asd`, Section 2):
- **`LIGHT`**: 1–3 files or one module/domain, delegable to internal `asd-<role>` subagents on the current harness's synced `routing.jsonc` model.
- **`HEAVY`**: heavy parallel tasks across disjoint subsystems needing isolated worktrees (`.asd/wt/<turn>-<taskId>`), or multi-harness cross-CLI execution / blind cross-model debate.

## 2. Planning Protocol

1. **Step 1: Read-Only Exploration (Internal Subagent Delegation)**
   - Inspect relevant files, tests, and architecture constraints.
   - Delegate read-only searches to the internal `asd-scout` subagent (`task` with `subagent_type: "asd-scout"` in OpenCode, `Agent`/`Task` in Claude Code, `invoke_subagent(TypeName="asd-scout", Model="flash_lite")` in Antigravity — **never pass `Model: "inherit"`**). Never spawn external CLI processes during planning.

2. **Step 2: Clarify Ambiguities**
   - If critical requirements are underspecified, ask concise questions before generating the plan.

3. **Step 3: Author `.asd/PLAN.md` via `asd plan`**
   - Define tasks with `taskId` (e.g., `T1.1`), `title`, `turn`, and exactly one of the 5 core `role` values (`planner`, `architect`, `worker`, `scout`, `critic`).
   - **Always classify `category` and `difficulty` explicitly** (do not omit them; `HEAVY` mode uses them to pick `routing.jsonc` models):
     - `category`: `visual-ui` (Web/Desktop GUI, TUI, HTML/CSS/layout, UI components/interactions) | `design` (architecture/API/state/UX design) | `research` (investigation/analysis) | `writing` (docs/guides/skills) | `general` (pure backend/logic/infra/tests, routed by `difficulty`: `low` | `medium` | `high`).
     - **Routing Tier & UI Separation Rule**: Domain categories (`visual-ui`, `design`, `research`, `writing`) activate Tier 3 routing **only when `role: "worker"`** (`architect`/`planner`/`scout`/`critic` take Tier 2 precedence and ignore `category`). Split UI/TUI work into dedicated `role: "worker", category: "visual-ui"` tasks instead of bundling it into `general` backend tasks.
   - Optionally add `dependsOn`, `contextHint`, and `acceptance` criteria for each task.
   - Set `track` (`"LIGHT"` or `"HEAVY"`) to match your recommendation, plus `targetFiles` and `verifyCmd`.
   - **Test File Permission & Verification Rule**: Always allow or include corresponding test files (`tests/*.test.ts`) in `targetFiles` when a task changes version constants, types, or runtime behavior so the verification gate (`npm test`) passes within the same turn. For documentation or skill-only tasks, set a targeted `verifyCmd` rather than running unrelated failing tests.
   - Persist and render:
     ```bash
     # Cross-platform payload file (Windows PowerShell/cmd, macOS, Linux):
     asd plan create --file <path.json>

     # Or via stdin payload (POSIX bash / PowerShell):
     asd plan create --payload - <<'EOF'
     {"tasks":[{"taskId":"T1.1","turn":1,"title":"<Task>","track":"HEAVY","role":"worker","category":"visual-ui","difficulty":"medium","targetFiles":["src/...","tests/..."],"verifyCmd":"npm test"}]}
     EOF
     # PowerShell: Get-Content plan.json -Raw | asd plan create --payload -
     ```
     *(Or via CLI flags: `asd plan --title "<Project/Feature Title>" --tasks '<JSON_ARRAY>'`)*
   - If `.asd/PLAN.md` already contains auto-created `[Cross-Scope ...]` tasks from a previous run, keep them scheduled in their assigned turn — do not renumber or delete them.

4. **Step 4: Present Plan, AI Mode Recommendation & Ask for Confirmation**
   - Display the generated `progressBoard` and task breakdown.
   - Present your recommendation (`LIGHT (Recommended)` vs `HEAVY (Recommended)`) with a clear rationale.
   - Ask the user to confirm:
     1. Run `/asd-run` in **`LIGHT` mode** (internal subagent delegation) or **`HEAVY` mode** (multi-harness worktree spawn across `claude`, `opencode`, `codex`, `agy`, and Cursor CLI).
     2. Or run `/asd-debate` first to stress-test the plan.
