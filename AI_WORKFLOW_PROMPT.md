# AI Agent Workflow Prompt (`AI_WORKFLOW_PROMPT.md`)

**English** | [한국어](./AI_WORKFLOW_PROMPT_ko.md) | [📖 Back to README](./README.md)

> **Usage**: When delegating work on this project to another AI agent (Claude Code, OpenCode, Codex, Antigravity, Cursor, etc.), copy and paste the prompt block below or instruct the agent: `Read @AI_WORKFLOW_PROMPT.md and start`.

---

## 📋 Ready-to-Use AI Workflow Prompt (Copy & Paste)

```markdown
You are an engineer developing and maintaining the `asd-multiagent` (Agent Swarm Director v2.5.0) project.
Before starting any work, you must strictly follow all rules and procedures below from start to finish.

### 1. Required Prerequisite Documents (Read Before Starting)
- `PROJECT_STATUS.md`: Full directory structure and detailed responsibilities of every file and core function
- `EXTERNAL_SDK_REFERENCE.md`: Public SDK specification for external GUI (`asd-gui`) integration and the single shared DB (`~/.asd/state/core.db`)

### 2. Five Non-Negotiable Core Constraints (Hard Constraints)
1. **Zero External Runtime Dependencies (`dependencies: {}`)**:
   - Never add third-party packages via `npm install <package>`.
   - Use only Node.js (`>=22.13.0`) built-in modules (`node:sqlite`, `node:fs`, `node:path`, `node:child_process`, `node:http`, `node:crypto`).
2. **Native TypeScript Syntax & JSDoc Comment Safety (`erasableSyntaxOnly: true`)**:
   - The CLI runs directly via `node --no-warnings src/cli/index.ts` without a separate `tsc` build step. Never use `enum`, `namespace`, or constructor `private`/`public` parameter properties.
   - **Never write `/*` or `*/` inside `/** ... */` JSDoc block comments in any file under `src/` (for example, `projects/*/*.jsonl`).** Doing so prematurely closes the JSDoc block and crashes the entire `PreToolUse` hook with a syntax error (write `projects/<dir>/*.jsonl` instead).
3. **Single Shared DB (`~/.asd/state/core.db`) & Test Home Isolation**:
   - When opening a DB connection, always scope the project via `openProjectDb(projectRoot, homeDir)` or `new SqliteDriver(dbPath, projectRoot)`.
   - When running tests, always use `node scripts/run-tests.mjs` (or `node scripts/run-tests.mjs tests/<file>.test.ts`) so the real user home directory (`~/.asd`) is never polluted.
4. **Core Purity & Public SDK Synchronization**:
   - `src/core/*` must never directly import from `src/adapters/*`.
   - Whenever you add or modify functions or types consumed externally (e.g., by `asd-gui`), update `src/index.ts` exports along with `EXTERNAL_SDK_REFERENCE.md` and `PROJECT_STATUS.md`.
5. **Git Commit Hygiene (No Contributor Pollution)**:
   - **Never include AI co-author trailers** such as `Co-Authored-By: Claude ...` in commit messages. Every commit must be authored solely under the user's identity.

### 3. Standard Step-by-Step Execution Procedure
1. **Exploration & Plan Briefing**:
   - Read the relevant files first (referencing `PROJECT_STATUS.md`) and concisely report the target file paths, planned changes, and expected impact. (If the user explicitly instructs you to execute autonomously end-to-end, proceed immediately.)
2. **Minimal-Scope Implementation**:
   - Modify only the files directly related to the requested feature, and do not arbitrarily delete existing comments or interfaces.
3. **Isolated Testing & Type Verification**:
   - Add or update unit tests for the modified module and run `npm test` (which executes `node --no-warnings scripts/run-tests.mjs`) or `node scripts/run-tests.mjs tests/<target>.test.ts` to verify a 100% pass rate.
   - If you touched types or interfaces, run `npx tsc --noEmit` to ensure zero compile errors for external consumers (`asd-gui`, etc.).
   - **Cross-Platform CLI Payload Rule**: When passing JSON or design proposals to `asd plan`, `asd verify`, or `asd debate`, prefer `--file <path.json>` (or `--proposal-file <path>`), which works reliably across Windows PowerShell, `cmd.exe`, macOS, and Linux without shell-escaping failures.
4. **Documentation Updates & Commit/Push**:
   - When function signatures or features are added or changed, update `PROJECT_STATUS.md`, `EXTERNAL_SDK_REFERENCE.md`, `PATCH_NOTES.md`, and `PATCH_NOTES_ko.md`.
   - When instructed by the user to commit/push, create a clean commit without `Co-Authored-By` and run `git push origin main`.
```

---

## ⚡ Quick One-Line Prompt Examples by Scenario

- **Adding or Modifying a Feature**:
  > `Read @AI_WORKFLOW_PROMPT.md and implement [desired feature]. Verify all tests pass, update the documentation, and commit/push.`
- **Autonomous Multi-Agent Execution via ASD**:
  > `/asd Follow @AI_WORKFLOW_PROMPT.md rules to implement [desired feature] end-to-end and commit/push after each task.`
- **Debugging an Issue**:
  > `/asd-debug Follow @AI_WORKFLOW_PROMPT.md rules to find the root cause of [bug symptom], write a reproduction test, and fix it.`
