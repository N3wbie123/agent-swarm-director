# Core–GUI Boundary Audit (CORE_GUI_BOUNDARY_AUDIT.md)

**English** | [한국어](./CORE_GUI_BOUNDARY_AUDIT_ko.md)

> Date: 2026-11-06 · Target: Empirical scan across all 26 TS files in `asd-multiagent` (Core) `src/`
> Scan Method: Full file inventory + grep for callers of `gui`/`createServer`/`<!DOCTYPE`/`WebSocket`/`runDriverTurn`/5 dashboard services + close inspection of candidate files

---

## 0. Boundary Principles (Confirmed)

| Remains in Core (`asd-multiagent`) | Moves to GUI Repo (`asd-gui` / new app) |
|---|---|
| 1. CLI (all `asd` commands) | All UI rendering (HTML/CSS/React) |
| 2. Core management: planning (`PLAN`), dashboard (`asd ui` — exception allowed), git worktree isolation/merge, session & driver state, hooks, MCP | HTTP/WS server hosting and routing (except `asd ui`) |
| 3. Minimal SDK/API: pure data and execution primitives such as streaming turns, transcript reading, session discovery, and routing loading | Browser/screen presentation strings, state, and event UI |

**Evaluation Axes**
1. Is the caller the CLI, a hook, MCP, or an agent? → Core OK
2. Is it a data/execution primitive (DB query, process spawn, stream parsing, git manipulation)? → Core OK (minimal SDK)
3. Is it server hosting, endpoint routing, screen rendering, or UI state? → Move to GUI
4. Exception: The `asd ui` command and its implementation (server + HTML in `src/cli/dashboard.ts`) are explicitly permitted by the user

---

## 1. Summary Verdict Table

| # | Location | Item | Verdict | Recommended Action |
|---|---|---|---|---|
| W1 | `src/cli/dashboard.ts:247/617/687/843/1461` | **5 data services imported by the GUI are implemented inside a presentation file** | ⚠️ Boundary Violation (Layering) | Move to service files under `src/core/`; keep only server + HTML in `dashboard.ts` |
| W2 | `src/index.ts` | Public SDK surface mixes dashboard server and services, including items unused by the GUI (`startDashboardServer`) | ✅ Completed (this change, T4.2) | Remove root export; restrict `startDashboardServer` to subpath `./cli/dashboard.ts` |
| W3 | `src/core/drivers.ts:423-424/482/588` | Comments and prompt text in GUI-oriented synchronous SDK blur the boundary | 🔵 Naming/Wording Issue (not behavior) | Clean up comments + parameterize GUI wording inside prompts |
| W4 | (Reverse) `asd-gui/src/server/core-api.ts:239` | GUI re-implements `buildInteractiveResumeHarnessCommand` — duplicating Core adapter `buildInteractiveResumeCommand` | 🔵 Reverse Violation | Delete GUI implementation and use Core implementation directly (execution note: adopted higher-level function re-export after discovering an adapter bug — see Section 5) |

**Conclusion: There is no blatant "GUI feature intrusion into Core"** (the web server and HTML exist only in the single `asd ui` exception). The violations consist of (1) a layering issue where services imported by the GUI are trapped in `dashboard.ts`, (2) an overly broad SDK surface, and (3) minor wording issues.

---

## 2. Detailed Findings

### W1. Five Data Services for the GUI Are Trapped in `dashboard.ts` (Presentation)

**Evidence** (`src/cli/dashboard.ts`):
- `discoverHarnessModels` (line 247) — 5-harness model discovery + `~/.asd/state/models-cache.json` cache
- `saveSessionMemo` (line 617) — session memo persistence
- `saveProjectRoutingConfig` (line 687) — routing configuration persistence
- `runSubagentControlAction` (line 843) — subagent kill/retry/fallback/resume
- `collectDashboardSnapshot` (line 1461) — full state snapshot

**Problem**: These 5 functions are **pure data/state services** rather than UI, yet they are implemented inside the 129KB HTML + server file for `asd ui` and re-exported through `src/index.ts:52-57` for `asd-gui` to import (confirmed in `asd-gui` `core-api.ts:132/135/180-182`). Mixing Core's "minimal SDK" and the "`asd ui` implementation" in a single file blurs the boundary — the GUI must pull in a 129KB UI file just to consume the SDK.

**Recommendation**: Move all 5 services to `src/core/` (e.g., `core/models.ts`, `core/session-services.ts`, `core/subagent-control.ts`). Leave only `startDashboardServer` + HTML in `cli/dashboard.ts`. Re-export from `src/index.ts` via `core`.

### W2. Overly Broad Public SDK Surface in `src/index.ts`

**Status (this change, T4.2 — Completed)**: Removed the `startDashboardServer` and `type DashboardServerHandle` root exports from `src/index.ts`. The dashboard server is now accessible exclusively via the subpath `./cli/dashboard.ts` (`agent-swarm-director/cli/dashboard.ts`) and is no longer exposed from the root SDK entry. Because `package.json` maps `./cli/*` → `./src/cli/*.ts`, the subpath import remains valid.

**Rationale**: `startDashboardServer` is never used by the GUI (`asd-gui` has its own server), so `asd ui`-specific implementation details should not be exposed on the root public SDK. The remaining dashboard data services (`collectDashboardSnapshot`, etc.) have already been migrated to `src/core/` and are re-exported via `core` (W1 completed).

### W3. GUI-Specific SDK Wording in `drivers.ts`

**Evidence**:
- Line 482: `// CR-03: GUI Headless Driver Turn Runner (runDriverTurn)` — a GUI change request (CR) number is baked into Core source code
- Line 588: `parseDriverStreamLine` comment mentions "for real-time GUI rendering"
- Lines 423-424: Driver briefing prompt hardcodes the phrase "merge conflict tasks are resolved by the user in the GUI"

**Verdict**: The behavior itself is legitimate — `runDriverTurn`, `parseDriverStreamLine`, and `buildDriverBriefing` are **essential minimal SDK primitives** in the new app plan, and driver CRUD (`attach`/`detach`) is used by MCP (`mcp/server.ts:862`, CR-04) as a Core management feature. However, the comments and prompts read as if they are "GUI-only", blurring the boundary.

**Recommendation**: Neutralize comments to caller-agnostic phrasing such as "SDK: Headless streaming turn execution", and parameterize GUI wording in prompts via options.

### W4. (Reverse) GUI Re-Implements Core Adapter Logic

**Evidence**: `asd-gui/src/server/core-api.ts:239` `buildInteractiveResumeHarnessCommand` — the GUI implements its own `agy` `--resume` → `--conversation` normalization, duplicating Core adapter `buildInteractiveResumeCommand` (`adapters/antigravity.ts:90`).

**Recommendation**: Delete the GUI implementation and use the Core adapter. Bidirectional boundary rule: "When core logic is needed, request it in Core rather than implementing it in the GUI (`GUI_ARCHITECTURE.md` ADR-01-3 states the same rule)."

**Update (2026-11-13, v2.6.0)**: The adapter methods above (`buildHeadlessCommand` / `buildResumeCommand` / `buildInteractiveResumeCommand`) were confirmed unused in production and **deleted** from the `HarnessAdapter` interface and all 5 adapters. The single canonical command-assembly path in Core is `buildSpawnSpec` / `buildHeadlessHarnessCommand` / `buildResumeHarnessCommand` / `buildInteractiveResumeHarnessCommand` in `src/core/session-tracker.ts`, and GUI/TUI consumers must use these functions directly (see the `core/session-tracker` table in the external SDK reference). The adapter bug discovery account in Section 5 is preserved as historical record.

---

## 3. Confirmed Retention List (Reviewed, No Violation)

| Location | Item | Retention Rationale |
|---|---|---|
| `src/mcp/server.ts` (78KB) + `mcp/stdio-rpc.ts` | `asd_plan`/`dispatch`/`verify`/`debate` + driver attachment | Core management for CLI & agent harnesses |
| `src/core/workspace.ts:1421-1942` | `getWorktreeDiff` / `approvePendingTask` / `rejectPendingTask` ("GUI Gate") | Git worktree diff/merge/rollback = **user-defined Core management capability**. Note: 0 internal callers in Core (confirmed via grep) — document explicitly as an external SDK surface for GUI consumers |
| `src/core/drivers.ts` | Driver CRUD (`attachDriver`, etc.), `runDriverTurn`, `parseDriverStreamLine`, `buildDriverBriefing` | CRUD is used by MCP; streaming turn & parser form the minimal SDK for the new app (only W3 wording cleanup needed) |
| `src/core/transcripts.ts` (CR-10) | 5-harness transcript reader | Minimal SDK for automatic session loading. Cursor does not provide a native format → only lossy JSONL fallback (`~/.asd/transcripts/cursor/`, `~/.cursor/transcripts/`) exists, returning `unsupported` when absent (updated 2026-11-13) |
| `src/cli/dashboard.ts` server + HTML | `asd ui` | **Explicit user exception**. Recommend codifying a feature-freeze rule going forward (new UI features belong in the GUI repo) |
| `src/core/{db,render,router,session-tracker,spawner,policy,debate,redact,jsonc,config}.ts`, `src/adapters/*`, `src/cli/index.ts` | All CLI / Core management / SDK | 0 GUI traces found via grep (all wording is Core management except 1 comment) |
| `.asd/sessions/` artifact layout | `drivers/<id>/runs/`, `subagents/<id>/` | GUI turn logs (`gui-turns`) are written and read directly by the GUI (`asd-gui` `routes/transcripts.ts`) — independent of Core ✅ |

---

## 4. Cleanup Action Checklist

1. [x] **(P1)** W1: Migrate 5 data services from `dashboard.ts` → `src/core/` — **Completed (2026-11-06)**. New files: `core/models.ts` (model discovery + cache), `core/session-services.ts` (memo + snapshot), `core/subagent-control.ts` (subagent control), `core/subagent-logs.ts` (`scanSubagentLogs` — re-exported by `cli/index.ts`). Moved `saveProjectRoutingConfig` to `core/router.ts`. Only server + HTML remain in `dashboard.ts` (-1,605 lines).
2. [x] **(P1)** W2: Clean up `src/index.ts` surface — **Completed**. Re-exported the 5 services + `getModelsDiskCachePath` via `core` (symbol names unchanged for `asd-gui` compatibility); removed `startDashboardServer` from root exports (accessible only via package subpath `./cli/dashboard.ts`).
3. [x] **(P2)** W3: Clean up `drivers.ts` — **Completed**. Neutralized CR-03 comments and "GUI rendering" wording; removed EN/KO GUI phrases from briefing prompts. Confirmed 0 occurrences of the string "GUI" in the file.
4. [x] **(P2)** W4: Remove duplication in `asd-gui` — **Completed (path adjusted)**. Originally planned to call the adapter method, but discovered an adapter bug during execution (Section 5) → deleted the GUI wrapper (30-line no-op normalization) and directly re-exported the higher-level Core function `buildInteractiveResumeHarnessCommand` from `core-api.ts`. All 4 call sites required zero changes.
5. [x] **(P3)** W5: Add the "`asd ui` feature freeze — new UI features go to `asd-gui`" rule to `README.md` / `README_ko.md` — **Completed**.
6. [ ] **(P3)** Enhance Cursor transcript reader — because the harness does not expose a native format, only a lossy JSONL fallback currently exists. Improving the fallback parser is tracked as a separate task (updated 2026-11-13).

---

## 5. Execution Results (2026-11-06)

**Tests**: Core `node scripts/run-tests.mjs` **355/356 passed**, `asd-gui` `npm test` **14/14 passed**.

**The single failure was a pre-existing issue unrelated to these changes**: `tests/installer-sync.test.ts:650` "Runtime Isolation: ... Staged CLI entrypoint must exist in isolated runtimeDir" — verified identical reproduction on the baseline `HEAD` via `git stash`. (Note: an existing `asd-auto-stash` entry was found during the stash comparison and preserved untouched.)

**Verification Evidence**:
- `src/core/**` → `src/cli/**` imports: 0 occurrences (grep)
- Definitions of the 5 services inside `src/cli/dashboard.ts`: 0 occurrences (grep); server code imports them from `core`
- "GUI" wording inside `src/core/drivers.ts`: 0 occurrences (grep)
- Updated import paths in 3 test files (`artifact-lifecycle`, `dashboard`, `subagent-resume`) to their new `core` locations during W1

**New Discovery → Immediate Fix**: Adapter `buildInteractiveResumeCommand` (`claude-code`/`opencode`/`codex`/`cursor`) had a bug where it **unconditionally generated invalid flags like `--resume ""` even on an empty session ID** (only `antigravity` handled it properly) → applied conditional guards (`harnessSessionId ? [...] : []`) across the 4 adapters. Behavior for valid session IDs is unchanged. Because this bug blocked the direct-adapter path for W4, W4 was completed by re-exporting the higher-level Core function instead.

**Transient Issue Encountered During Execution (For Record)**: While executing W1, `asd-gui` tests briefly failed with a parse error in Core `router.ts`; this was a race condition where `asd-gui`'s live-linked `node_modules/agent-swarm-director` read an intermediate write state during refactoring. It did not reproduce in the final state.
