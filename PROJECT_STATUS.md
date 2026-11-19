# Agent Swarm Director (ASD v2.5.0) — Architecture & Full File/Function Reference

> **Last Updated**: 2026-11-04  
> **Version**: `2.5.0` (`agent-swarm-director`)  
> **Target Harnesses (5 AI Coding CLIs)**: Claude Code (`@cc`), OpenCode (`@oc`), Codex CLI (`@cx`), Antigravity (`@ag`), Cursor CLI (`@cr`)  
> **External Runtime Dependencies**: `0` (`dependencies: {}` — uses only pure Node.js `>=22.13.0` built-in modules)

**English** | [한국어](./PROJECT_STATUS_ko.md) | [📖 README](./README.md) | [🔌 External SDK & DB Reference](./EXTERNAL_SDK_REFERENCE.md) | [🤖 AI Workflow Prompt](./AI_WORKFLOW_PROMPT.md) | [📋 Patch Notes](./PATCH_NOTES.md)

---

## 1. Project Overview & Three Core Architectural Invariants

**Agent Swarm Director (ASD v2.5.0)** is a **zero-dependency** multi-agent orchestration engine and SDK that unifies five heterogeneous AI coding harnesses (**Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**, and **Cursor CLI**) under a single deterministic control plane.

### 1.1 Three Core Architectural Invariants
1. **Zero External Runtime Dependencies (`dependencies: {}`)**:
   - Runs directly on **Node.js `>=22.13.0`** native TypeScript execution (`--no-warnings` / `--experimental-strip-types`) and built-in standard modules (`node:sqlite` in WAL mode, `node:http`, `node:child_process`, `node:crypto`, `node:fs`) without third-party npm runtime packages or separate transpilation/build steps.
2. **Strict Core Purity**:
   - `src/core/*` modules never directly import `src/adapters/*`, operating independently without circular coupling to the adapter layer.
3. **Erasable TypeScript Syntax Only**:
   - Complies with Node.js native TypeScript execution (`erasableSyntaxOnly: true`) by avoiding `enum`, `namespace`, and constructor parameter properties in favor of pure type unions (`type`) and `as const` arrays.

---

## 2. Directory & Full File Structure

```text
asd-multiagent/
├── package.json                 # Zero runtime dependencies, version 2.5.0, bin: {"asd": "./src/cli/index.ts"}, exports subpaths
├── tsconfig.json                # erasableSyntaxOnly: true, strict: true
├── README.md / README_ko.md     # English/Korean user manual (skills & CLI guide)
├── PROJECT_STATUS.md / _ko.md   # Full architecture and file-by-file / function-by-function reference (this document)
├── EXTERNAL_SDK_REFERENCE.md    # SDK API & single-DB migration reference for external integrations (asd-gui, etc.)
├── PATCH_NOTES.md / _ko.md      # English/Korean version-by-version patch notes
├── HARNESS_INTEGRATION_REFERENCE.md  # Harness integration reference for app teams (storage, formats, empirical event schemas, caveats, v2.5.0)
├── docs/
│   ├── CORE_GUI_BOUNDARY_AUDIT.md   # Core-GUI boundary audit (GUI separation principles and violation cleanup, v2.4.3)
│   ├── ORCHESTRATOR_APP_PLAN.md     # Orchestrator TUI/GUI app development plan (including empirical harness matrix)
│   └── SDK_SURFACE_CLEANUP_PLAN.md  # Public SDK surface cleanup plan (breaking-change candidates & removal conditions ahead of ASD-Nexus rewrite)
├── presets/
│   ├── default-routing.jsonc    # Default model routing across 5 specialist roles and category/difficulty tiers + multi-fallback chains
│   └── default-mcp.jsonc        # Gap-filling MCP server catalog (context7, grep_app, websearch)
├── scripts/
│   └── run-tests.mjs            # Full/selective test runner with isolated temporary ASD_HOME_DIR
├── src/
│   ├── index.ts                 # Unified Public SDK entrypoint for external libraries (asd-gui, etc.)
│   ├── core/                    # Core orchestration engine (zero adapter dependencies)
│   │   ├── types.ts             # Global constants/types (5 harnesses, 5 roles, 3 difficulty tiers, driver, task, debate schemas)
│   │   ├── config.ts            # 2-Path layout (~/.asd and <project>/.asd), single core.db path, routing config loader
│   │   ├── db.ts                # node:sqlite WAL-mode 4-table SSOT driver (sessions, tasks, debates, session_drivers)
│   │   ├── session-tracker.ts   # Project discovery, 5-harness local CLI session discovery/tracking, CLI <-> ASD session promote/demote, `ses_` session attribution fix & cli-recent self-healing
│   │   ├── acp-client.ts        # Zero-dependency ACP JSON-RPC 2.0 client (AcpStdioClient), harness ACP probing (probeAcpCapability), permission guard
│   │   ├── drivers.ts           # Multi-driver ownership (session_drivers), 0-Token briefing (default locale 'en'), resident ACP session pool & streaming turn runner (runDriverTurn)
│   │   ├── transcripts.ts       # 5-harness local transcript discovery & 4-category parser (Thinking, Tool Use, Tool Result, Assistant/User)
│   │   ├── router.ts            # 4-tier model routing, uninstalled harness filtering, diverse reviewer selection, automatic fallback chain, project routing persistence (saveProjectRoutingConfig)
│   │   ├── spawner.ts           # Subagent process spawning, secret-redacted logging, process-tree termination, artifact finalization
│   │   ├── workspace.ts         # Git baseline protection, LIGHT checkpoint/rollback, HEAVY worktree & cross-process mutex merge
│   │   ├── file-lock.ts         # Shared cross-process advisory file lock (merge.lock, cli-recent.lock, PID/age-based stale recovery, re-entrant support)
│   │   ├── debate.ts            # Blind cross-model adversarial debate broker (Round 1 parallel critique + Round 2 arbitration)
│   │   ├── policy.ts            # 1ms PreToolUse path/command guard, ASD_DRIVER_ID binding & Stop hook 3-strike no-progress circuit breaker
│   │   ├── render.ts            # Bidirectional .asd/PLAN.md parser/renderer, foreground session control, live English-default progressBoard, summary.md generation
│   │   ├── redact.ts            # Automatic masking ([REDACTED]) of API keys, JWTs, PEM keys, and passwords
│   │   ├── jsonc.ts             # Comment/trailing-comma safe JSONC parser & TOML fenced block manager
│   │   ├── models.ts            # Parallel 5-harness model discovery + models-cache.json disk cache (migrated from cli/dashboard in v2.4.3)
│   │   ├── session-services.ts  # Session memo persistence & unified dashboard snapshot collection (migrated in v2.4.3)
│   │   ├── subagent-control.ts  # Subagent runtime control (kill/retry/fallback/custom/resume) (migrated in v2.4.3)
│   │   └── subagent-logs.ts     # Subagent artifact log scanner (migrated from cli/index in v2.4.3)
│   ├── adapters/                # 5 AI harness adapters & global installer
│   │   ├── claude-code.ts       # Claude Code (@cc) adapter (~/.claude, ~/.claude.json)
│   │   ├── opencode.ts          # OpenCode (@oc) adapter (~/.config/opencode)
│   │   ├── codex.ts             # Codex CLI (@cx) adapter (~/.codex/config.toml)
│   │   ├── antigravity.ts       # Antigravity (@ag) adapter (~/.gemini)
│   │   ├── cursor.ts            # Cursor CLI (@cr) adapter (~/.cursor)
│   │   └── installer.ts         # Global sync (sync), surgical removal (uninstall), 100ms health check (doctor)
│   ├── mcp/                     # MCP protocol & orchestration handlers
│   │   ├── server.ts            # handlePlan, handleDispatch, handleVerify, handleDebate core handlers & Subagent Isolation Guard
│   │   └── stdio-rpc.ts         # Async JSON-RPC 2.0 stdio transport
│   ├── cli/                     # Unified terminal CLI & local web dashboard
│   │   ├── index.ts             # Entrypoint for 14 CLI subcommands (plan, dispatch, verify, debate, resume, sync, ui, etc.)
│   │   └── dashboard.ts         # English-default ('en') / Korean bilingual Zero-Dependency live web dashboard (http://127.0.0.1:3847) — data services migrated to core/ in v2.4.3, server+UI only
│   └── skills/                  # Shared slash-skill templates deployed across all 5 harnesses (asd, asd-plan, asd-run, asd-debug, asd-debate, handoff)
└── tests/                       # 97 test suites, 405 unit/integration tests
```

---

## 3. 2-Path State Storage & Single Shared SQLite DB Architecture (v2.4.0)

ASD v2.4.0 separates storage into a **global state directory (`~/.asd`)** and a **project-local view directory (`<project>/.asd`)** to prevent project repository pollution and guarantee multi-project, multi-process concurrency.

### 3.1 Global State Directory (`~/.asd`)
- **`~/.asd/state/core.db` (Single Shared SQLite SSOT)**:
  - Legacy versions (`<= v2.3.2`) created a separate `~/.asd/state/<projectHash>/core.db` per project. Starting in `v2.3.3` / `v2.4.0`, **a single `~/.asd/state/core.db`** stores sessions across all projects and scopes them via the `sessions.project_root` column (automatic legacy DB migration and schema recovery are handled by the built-in `asd migrate [--clean-legacy]` command).
  - Safe under concurrent multi-process access via WAL mode (`journal_mode = WAL`), `busy_timeout = 5000`, `foreign_keys = ON`, and `BEGIN IMMEDIATE` transactions.
  - Consists of 4 tables: `sessions`, `tasks`, `debates`, and `session_drivers`.
- **`~/.asd/state/cli-recent.json`**:
  - Registry of recent CLI sessions recorded by the `SessionStart` / `PreToolUse` / `Stop` hooks across all 5 harnesses and the local transcript scanner (`syncLocalHarnessTranscripts`), preserving the initial user prompt `summary` and `transcriptPath`.
- **`~/.asd/state/models-cache.json`**:
  - 10-minute (TTL) disk cache storing the 5-harness model catalog discovered asynchronously in parallel by `discoverHarnessModels()`.
- **`~/.asd/routing.jsonc`, `~/.asd/mcp.jsonc`**:
  - Global model routing configuration and Gap-Filling MCP catalog configuration files.

### 3.2 Project-Local View Directory (`<project>/.asd`)
The `<project>/.asd/` folder is automatically registered in `.git/info/exclude` so it never pollutes Git commit history.
- `.asd/PLAN.md`: Human- and AI-editable Markdown task plan (specifies the foreground session via the top `Session: <sessionId>` header).
- `.asd/routing.jsonc`: Optional project-local model routing override configuration taking precedence for that project.
- `.asd/merge.lock`: File mutex lock preventing cross-process contention during `HEAVY` worktree merges.
- `.asd/sessions/<sessionId>/main.json`: Session metadata, memo (`memo`), and active driver list (`drivers`).
- `.asd/sessions/<sessionId>/subagents/<subSessionId>/`: Per-subagent `meta.json`, `prompt.md`, and `output.log`.
- `.asd/sessions/<sessionId>/summary.md` (and `.asd/summary.md`): Final summary report generated when all tasks complete.
- `.asd/wt/<turn>-<taskId>/`: Per-task isolated Git worktree created during `HEAVY` track execution.

---

## 4. Detailed File & Function Reference

### 4.1 Public SDK Entrypoint — [`src/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/index.ts)
Re-exports all modules so external applications (such as `asd-gui`) can reuse the full core functionality via a single `import { ... } from "agent-swarm-director"`.
- Exposes all `src/core/*` modules, the 5 `src/adapters/*` adapters and installer, `src/mcp/server.ts` orchestration handlers (`handlePlan`, `handleDispatch`, `handleVerify`, `handleDebate`), `src/cli/index.ts` helpers (`getAdapter`, `getLatestSession`, `runAsdLogs`, `runAsdClean`), and dashboard data services (`collectDashboardSnapshot`, `discoverHarnessModels`, `getModelsDiskCachePath`, `saveSessionMemo`, `saveProjectRoutingConfig`, `runSubagentControlAction`, `scanSubagentLogs`). `startDashboardServer` is excluded from the root entry (change T4.2) and is accessed only via the subpath `agent-swarm-director/cli/dashboard.ts`.

---

### 4.2 Core Engine (`src/core/`)

#### 1. [`src/core/types.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts)
Leaf module defining constant arrays (`as const`) and TypeScript interfaces across the system.
- **Key Constants & Union Types**:
  - [`ASD_VERSION`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L11) (`"2.5.0"`): Package and configuration version constant.
  - [`HARNESS_IDS`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L17-L23) / `HarnessId`: `"claude-code" | "opencode" | "codex" | "antigravity" | "cursor"`.
  - [`AGENT_ROLES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L31-L37) / `AgentRole`: 5 core roles (`"planner" | "architect" | "worker" | "scout" | "critic"`).
  - [`TASK_CATEGORIES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L42-L48) / `TaskCategory`: `"visual-ui" | "design" | "research" | "writing" | "general"`.
  - [`DIFFICULTY_TIERS`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L53-L57) / `DifficultyTier`: `"low" | "medium" | "high"`.
  - [`TASK_TRACKS`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L61) / `TaskTrack`: `"LIGHT" | "HEAVY"`.
  - [`TASK_STATUSES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L65-L73) / `TaskStatus`: `"pending" | "running" | "verifying" | "awaiting_approval" | "done" | "escalated" | "failed" | "merge_conflict"`.
  - [`SESSION_PHASES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L77) / `SessionPhase`: `"planning" | "running" | "paused" | "done"`.
  - [`DRIVER_SOURCES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L85) / `DriverSource`: `"cli" | "gui" | "subagent"`.
- **Key Interfaces**:
  - `SessionRecord`, `TaskRecord`, `DebateRecord`, `DriverRow`, `DoneClaim`, `CrossScopeFileRequest`, `RoutingConfig`, `McpCatalogConfig`, `HarnessAdapter`, `HookEvaluationInput`, `HookEvaluationResult`.

#### 2. [`src/core/config.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts)
Handles home directory and project path resolution, configuration loading (`routing.jsonc`, `mcp.jsonc`), and remote update checks.
- [`resolveHomeDir(explicitHomeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L102-L108): Resolves the home directory with priority `explicitHomeDir > process.env.ASD_HOME_DIR > os.homedir()` (preventing user home pollution during tests).
- [`computeProjectHash(projectRoot)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L114-L125): Normalizes via `fs.realpathSync.native` (and lowercase on Windows) and returns the first 16 hex characters of the SHA-256 hash.
- [`resolveAsdPaths(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L131-L162): Returns both global `~/.asd` paths (`dbPath: ~/.asd/state/core.db`, `globalRoutingPath`, `globalMcpPath`, `lastSyncPath`) and local `<project>/.asd` paths (`planMdPath`, `sessionsDir`, `worktreesDir`, `localRoutingPath`).
- [`ensureProjectInitialized(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L204-L242): Creates `~/.asd/state` and `<project>/.asd/{sessions,wt}` directories and adds `.asd/` to `.git/info/exclude`.
- [`loadRoutingConfig(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L276-L315): Deep-merges global (`~/.asd/routing.jsonc`) and project-local (`<project>/.asd/routing.jsonc`) overrides onto the default preset (`presets/default-routing.jsonc`).
- [`loadMcpCatalog(homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L321-L347): Loads `~/.asd/mcp.jsonc` or the default MCP catalog.
- [`checkForRemoteUpdate(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L403-L485): Checks the latest `package.json` version on GitHub using a 24-hour cache to provide update notifications.

#### 3. [`src/core/db.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts)
SSOT driver managing the 4 tables (`sessions`, `tasks`, `debates`, `session_drivers`) in `~/.asd/state/core.db` using Node.js built-in `node:sqlite` (`DatabaseSync`).
- [`generateAsdSessionId(now?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L56-L78) / [`isValidAsdSessionId(id)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L45-L49): Collision-free session ID (`asd-YYYYMMDD-HHMMSS-xxxx`) generation and path-safety validation.
- **[`SqliteDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L288-L1025) Class**:
  - `constructor(dbPath, projectRoot?)`: Opens the DB connection, automatically applies WAL mode, foreign keys, and schema migrations, and automatically scopes read queries to `projectRoot` when provided.
  - `withImmediateTx(fn)`: `BEGIN IMMEDIATE` transaction wrapper (joins the outer transaction on nested calls).
  - **Session Management**: `createOrGetSession()`, `getSession()`, `findSessionByHarnessSessionId()` (unified lookup across `sessions` and `session_drivers` by native harness session ID), `deleteSession()` (cascading delete transaction across `session_drivers`, `tasks`, `debates`, and `sessions`), `getLatestSession()`, `listSessions()`, `listProjectRoots()`, `updateSessionPhase()`, `updateSessionHarnessInfo()`, `updateSessionMemo()`, `incrementNoProgress()`, `resetNoProgress()`, `setStashedWorkSha()`.
  - **Task Management**: `upsertTasks()`, `getTask()`, `getTasksBySession()`, `getTasksByTurn()`, `getAllTasks()`, `tryClaimTask()` (atomic `pending/escalated -> running` transition), `claimWaveTasks()`, `updateTaskStatus()`, `recordTaskVerified()`, `recordTaskAttemptFailure()`.
  - **Debate Management**: `createDebate()`, `getDebate()`, `getDebatesBySession()`, `getAllDebates()`, `updateDebateBundles()`.
  - **Driver Management (`session_drivers`)**: `insertDriverRow()`, `getDriverById()`, `getActiveDriver()`, `listDriverRows()`, `updateDriverHarnessSessionId()`, `touchDriverSeen()`, `closeActiveDriversForSession()`, `closeDriverById()`.
- [`openProjectDb(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L1030-L1040): Initializes the project and returns a `SqliteDriver` instance scoped to `projectRoot`.

#### 4. [`src/core/session-tracker.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts)
Handles CLI session ID extraction across the 5 harnesses, local transcript scanning, bidirectional CLI <-> ASD session promotion/demotion, and multi-project discovery.
- [`extractHookSessionInfo(rawPayload)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L229-L360): Normalizes and extracts `harnessSessionId`, `transcriptPath`, `cwd`, `model`, and `promptSummary` from JSON payloads delivered by each harness hook.
- [`buildHeadlessHarnessCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L85-L185), [`buildResumeHarnessCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L190-L245) & [`buildInteractiveResumeHarnessCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L250-L315): Builds initial/resumed headless commands and interactive TUI resume commands (`claude --resume <id>`, `codex resume <id>`, `opencode -s <id>`, `cursor-agent --resume <id>`, `agy chat --resume <id>`) directly in core without importing adapters (preserving core purity).
- [`syncLocalHarnessTranscripts(projectRoot, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1200-L1308): Directly scans local storage for Antigravity (`brain/`), Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), and OpenCode (`opencode.db`) to recover CLI sessions missed by hooks into `cli-recent.json` (`transcriptDiscoveryCache` returns cached entries immediately without re-parsing `.jsonl` files whose `mtimeMs` has not changed).
- [`recordCliRecentSession(entry, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1331-L1410) & [`readCliRecentSessions(filter?, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1310-L1329): Records (preserving existing first-prompt `summary` and `transcriptPath`) and queries recent CLI sessions in `~/.asd/state/cli-recent.json`.
- [`linkHarnessSessionToAsdSession(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1415-L1450): Links a native harness session ID to an ASD session (automatically running `syncLocalHarnessTranscripts` when no candidate is found).
- [`promoteCliSessionToAsd(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1680-L1845): Immediately promotes a plain CLI session into an ASD session (`sessions` table; reuses existing mapped session with `created: false`), attaches an active driver (`session_drivers`), and sets the foreground session in `.asd/PLAN.md` when `makeForeground: true` (returns `{ sessionId, asdSessionId, created, driverId, driver, session, harness, harnessSessionId, model, mainJsonPath }`).
- [`unlinkHarnessSessionFromAsdSession(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1850-L1955): Inverse of `promoteCliSessionToAsd()` — detaches active drivers (or deletes the session when `deleteAsdSession: true`) and resets `asdSessionId` to `null` in `cli-recent.json`, restoring plain CLI session state.
- [`demoteAsdSession(projectRoot, sessionId, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1520-L1610) & [`buildSessionDemotion(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L2070-L2145): Pauses (`paused`) an ASD session, detaches its driver, returns the interactive resume command to return to the original harness CLI, and updates `cli-recent.json` (falling back to `session.harness_session_id` and historical drivers even if no active driver is attached).
- [`discoverProjectCliSessions(projectPath, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1774-L1895): Discovers all CLI sessions across the 5 harnesses executed in a given project path, joins ASD promotion state (`isPromotedToAsd`, `asdSessionId`, `asdPhase`), and returns them sorted newest-first.
- [`listKnownProjects(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1901-L1980): Fast aggregation of per-project session/task/debate statistics from the single shared DB (`core.db`) (supports 15s FS stat cache, `skipDiskCheck`, and `db` instance reuse).

#### 5. [`src/core/drivers.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts) & [`src/core/acp-client.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/acp-client.ts)
Manages ownership (`session_drivers`), handoff briefings, resident ACP/CLI streaming turn execution, and JSON-RPC protocol control when multiple harnesses or GUI/CLI clients take turns driving an ASD session.
- [`attachDriver(db, options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L98-L195) / [`detachDriver(db, options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L220-L265): Attaches a new driver (`cli` | `gui` | `subagent`) to a session (automatically closing any prior active driver with `handover` and cleaning up resident ACP sessions) or detaches an existing driver.
- [`buildDriverBriefing(db, sessionId, maxChars?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L315-L445): Generates a 0-Token briefing summary of prior work context (completed task `DoneClaim` records, in-progress tasks, debate constraints, and driver handover history) when switching harnesses or models (`locale?: "ko" | "en"`, defaulting to `'en'`).
- [`parseDriverStreamLine(harness, rawLine)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L583-L920): Parses real-time JSON stream lines emitted by Claude Code/Cursor (`stream-json`), Codex (`--json`), and OpenCode (`--format json`) into structured `DriverStreamEvent` arrays (`thinking`, `tool_use`, `tool_result`, `text`, `status`, `raw`).
- [`runDriverTurn(input)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L1501-L2110): Accepts `RunDriverTurnInput` (`transport?: "auto" | "acp" | "cli"`, `autoApprove?`, `onPermissionRequest?`, `model?`, `signal?`, etc.) and executes a turn via the resident `DriverSessionPool` (`driverSessionPool` + `AcpStdioClient`) or CLI fallback. On the ACP path, maps `AcpNormalizedEvent` to `DriverStreamEvent` for `onEvent` streaming (without interfering with `onOutput`), and controls `session/cancel` and session pool lifecycle via `cancelDriverTurn(sessionId)` / `closeDriverSession(sessionId)` / `closeAllDriverSessions()`.
- [`probeAcpCapability(harness, env?, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/acp-client.ts#L238-L348) & [`AcpStdioClient`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/acp-client.ts#L830-L1470): Probes harness ACP readiness with `interactivePermissions` support, provides `isConnected` / `setSessionModel` / `setTurnHandlers` / `cancelSession`, and pre-checks workspace/protected-path safety (`checkInteractivePermissionSafety`) before relaying interactive permission requests via `onPermissionRequest`.

#### 6. [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts)
Locates conversation transcripts on local disk/DB across the 5 harnesses and parses them into **4 structured categories (Thinking, Tool Use, Tool Result, User/Assistant messages)**.
- [`locateHarnessTranscript(query)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L140-L260): Locates the local transcript file (`.jsonl`, `.json`) or SQLite DB (`opencode.db`) based on harness type, project path, and `harnessSessionId`.
- [`readHarnessTranscript(query)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L995-L1084):
  - **Claude Code**: Separates `thinking`, `tool_use`, `tool_result`, and `text` content blocks in `~/.claude/projects/<encoded>/*.jsonl` into individual `TranscriptMessage` entries.
  - **Codex CLI**: Parses `event_msg` (`agent_reasoning`, `user_message`, `agent_message`) and `response_item` (`reasoning`, `function_call`, `custom_tool_call`, `function_call_output`) in `~/.codex/sessions/**/<id>.jsonl` into the 4 categories.
  - **OpenCode**: Parses both `message` and `part` tables (`reasoning`, `tool`, `step-start`, `text`) in `~/.local/share/opencode/opencode.db` as well as JSON storage.
  - **Antigravity**: Parses `USER_INPUT`, `PLANNER_RESPONSE` (separating `thinking` and `tool_calls`), and `TOOL_RESPONSE` in `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, automatically restoring untruncated text from the matching line in `transcript_full.jsonl` whenever `truncated_fields` is detected.
  - **Cursor**: Safely returns `{ unsupported: true, messages: [] }` because Cursor CLI does not expose plaintext local transcript files.

#### 7. [`src/core/router.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts)
Assigns the optimal harness and model based on task role, category, and difficulty, and drives fallback chains on failure.
- [`resolveRoute(req, config)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L295-L420): Resolves routing across 4 priority tiers (1. explicit pin -> 2. 5-agent role match -> 3. domain category match -> 4. difficulty match). When a single harness is pinned (`pinnedHarness`), automatically searches `fallbacks` for a matching model on that harness.
- [`resolveFallback(currentDecision, attemptIndex)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L425-L465) & [`runWithFallbacks(initialDecision, runner)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L495-L580): Automatically walks the configured `fallbacks` chain in order upon quota exhaustion (`429`, `quota exceeded`), network errors, or abnormal termination.
- [`escalateTaskRoute(req, config, attempt)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L470-L492): Automatically escalates tasks that fail verification 2 or more times to the `architect` role and `high` difficulty tier model.
- [`selectDiverseReviewer(primaryHarness, primaryModel, config, exclude?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L585-L650): Prioritizes a different model family (`claude` vs `gpt` vs `gemini` vs `glm`) from the primary model during adversarial debate to prevent confirmation bias.

#### 8. [`src/core/spawner.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts)
Spawns external harness CLI subprocesses in the background and manages timeouts, secret redaction, process-tree termination, and artifact recording.
- [`resolveSpawnCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L104-L175): Assembles non-interactive execution arguments per harness as well as sub-session continuation (`resumeSessionId`) commands.
- [`spawnSubagent(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L310-L520): Writes `meta.json`, `prompt.md`, and real-time secret-redacted `output.log` under `.asd/sessions/<sessionId>/subagents/<subSessionId>/` while enforcing idle (`idleTimeoutMs`) and wall-clock (`wallClockTimeoutMs`) timeouts.
- [`killProcessTree(pid)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L60-L95): Cleanly terminates child process trees on Windows (`taskkill /PID <pid> /T /F`) and POSIX (`process.kill(-pid, "SIGKILL")`).
- [`finalizeSubagentArtifacts(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L530-L600): Finalizes subagent `meta.json` and `output.log` upon `claim_only` mode and `asd verify` completion.

#### 9. [`src/core/workspace.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts)
Handles Git working-tree protection, `LIGHT` checkpoint commits/rollbacks, `HEAVY` worktree creation/merging, and orphaned task recovery.
- [`prepareBaseline(projectRoot, db, sessionId)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L375-L430): Safely stashes uncommitted changes at session start via `git stash push -u` and records `stashed_work_sha` in the DB.
- [`verifyAndCommitLightTask(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L505-L625): Verifies that modified files on the `LIGHT` track remain within `targetFiles` boundaries and contain no leaked secrets, creating a checkpoint commit (`asd(<taskId>): <title>`) when `verifyCmd` passes. On boundary/secret failure, immediately rolls back only that task's scope via [`rollbackLightChanges()`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L450-L500).
- [`createTaskWorktree(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L220-L310) & [`verifyAndMergeHeavyTask(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L630-L790): Creates an isolated `.asd/wt/<turn>-<taskId>` worktree on the `HEAVY` track and links the root `node_modules` via junction; once verification passes, removes the junction and performs a `--no-ff` merge under the cross-process file lock (`.asd/merge.lock`, `withMergeLock`) (supports `approvePendingTask` / `rejectPendingTask` for manual approval tasks when `autoApprove: false`).
- [`recoverOrphanedTasks(db, projectRoot, sessionId)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L850-L940) & [`isPidAlive(pid)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L171-L185): Detects `running` tasks owned by dead processes and automatically recovers them to `pending` or `escalated`.

#### 10. [`src/core/debate.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/debate.ts)
Executes blind cross-model critique (Round 1) and arbiter consensus judgment (Round 2).
- [`runDebateBroker(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/debate.ts#L310-L520): Directly injects code slices (`--files path:start-end`) and `git diff HEAD` into the prompt (0-Token lookup), runs 2 heterogeneous model reviewers in parallel, and passes anonymized critiques (`Reviewer A`, `Reviewer B`) to the `arbiter` to produce the final verdict (`APPROVE` | `MINOR_AMEND` | `REJECT`, `hard_constraints`, `decisions`, `risks`).
- [`formatDebateAcceptance(existingAcceptance, verdict)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/debate.ts#L530-L565): Automatically injects derived `hard_constraints` into the target task's `acceptance` field.

#### 11. [`src/core/policy.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/policy.ts)
1ms security guard and circuit breaker invoked by the `PreToolUse` and `Stop` hooks across all 5 harnesses.
- [`evaluatePreToolUse(input)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/policy.ts#L580-L760):
  - Immediately blocks modifications to protected paths (`.git/`, `.asd/`, `.env*`, `*.pem`, `*.key`, `id_rsa*`) and destructive shell commands (`git reset --hard`, `git push --force`, `rm -rf /`, etc.) with case-insensitive and symlink-normalized path checks.
  - For subagents (`ASD_SESSION_ROLE=subagent`), blocks modifications to any file outside the assigned `allowedFiles`.
- [`evaluateStopHook(input)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/policy.ts#L770-L890):
  - Allows subagents to exit immediately (Subagent Shield).
  - In the main director session, holds termination and returns continuation guidance while incomplete (`pending`/`running`/`escalated`) tasks remain; after 3 consecutive stop attempts without progress (`no_progress_count >= 3`), trips the circuit breaker, transitions the session to `paused`, and allows exit.

#### 12. [`src/core/render.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts), [`src/core/redact.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/redact.ts), [`src/core/jsonc.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts)
- **`render.ts`**:
  - [`renderPlanMd(sessionId, tasks)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L110-L185) / [`parsePlanMd(markdown)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L220-L480) / [`syncPlanFromMd(projectRoot, db, sessionId?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L485-L560): Handles bidirectional rendering, parsing, and reverse synchronization between `.asd/PLAN.md` and the SQLite `tasks` table.
  - [`getForegroundSessionId(projectRoot)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L65-L105) / [`setForegroundSession(projectRoot, db, sessionId)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L565-L600): Manages the project's foreground session via the top `Session:` header in `.asd/PLAN.md`.
  - [`renderProgressBoard(tasks, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L605-L710) & [`renderSessionSummaryMd(session, tasks, debates)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L715-L790): Generates the live English-default Markdown progress board (`progressBoard`: `### 📊 ASD TODO Progress [Turn X/Y done | Progress: M/N (P%)]`) and final `summary.md`.
- **`redact.ts`**:
  - [`redactSecrets(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/redact.ts#L55-L85) / [`containsSecrets(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/redact.ts#L90-L115): Detects Anthropic/OpenAI/GitHub/Google/AWS API keys, Bearer tokens, PEM private keys, and password patterns, replacing them with `[REDACTED]` or blocking pre-commit leaks.
- **`jsonc.ts`**:
  - [`parseJsonc(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L95-L105) / [`stripJsoncComments(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L15-L90): Strips comments and trailing commas without corrupting `//` or `/*` inside string literals.
  - [`upsertTomlFencedBlock(existingToml, blockContent)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L115-L160) / [`removeTomlFencedBlock(existingToml)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L165-L190): Surgically inserts or removes only the `# >>> ASD MANAGED START >>>` fenced block inside Codex `~/.codex/config.toml`.

---

### 4.3 5-Harness Adapters & Installer (`src/adapters/`)

- **[`claude-code.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/claude-code.ts), [`opencode.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/opencode.ts), [`codex.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/codex.ts), [`antigravity.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/antigravity.ts), [`cursor.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/cursor.ts)**:
  - All adapters implement the common `HarnessAdapter` interface:
    - `detectCli()`: Detects binary path (`claude`, `opencode`, `codex`, `agy`, `cursor-agent`/`agent`), version, and headless support.
    - `buildHeadlessCommand(options)`: Generates CLI argument arrays and environment variables for non-interactive subagent execution.
    - `getCapabilities()`: Returns built-in tool capabilities (`nativeLsp`, `nativeWebSearch`, `supportsHooks`, etc.) to prevent duplicate injection during Gap-Filling MCP sync.
- **[`src/adapters/installer.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts)**:
  - [`syncGlobalHarnesses(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts#L1310-L1520): Idempotently synchronizes 7 skills, 5 agent personas, safety hooks (`PreToolUse`, `Stop`, Codex `notify`, Cursor nested `hooks.json`), missing MCP servers, and the global `PATH` `asd` execution shim into the global config directories of all 5 harnesses (`~/.claude`, `~/.config/opencode`, `~/.codex`, `~/.gemini`, `~/.cursor`).
  - [`uninstallGlobalHarnesses(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts#L1525-L1690): Surgically removes only ASD-installed hooks, fenced blocks, `_asdManaged` MCP entries, agents, and skills while preserving the user's existing configuration 100%.
  - [`runDoctor(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts#L1695-L1830): Diagnoses Node version, SQLite WAL, Git repository state, 5-harness binary status, and `PreToolUse` guard operation within 100ms.

---

### 4.4 MCP Server & Orchestration Handlers (`src/mcp/`)

- **[`src/mcp/server.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts)**:
  - Core orchestration handlers shared by both the CLI (`asd plan`, `asd dispatch`, `asd verify`, `asd debate`) and the MCP server (`AsdMcpServer`).
  - [`handlePlan(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L590-L820): Processes `create`, `get`, `update`, and `sync_from_md` actions, synchronizing SQLite `tasks` with `.asd/PLAN.md` and `.asd/sessions/<id>/main.json` while automatically linking the main harness session.
  - [`handleDispatch(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L825-L1250):
    - Performs orphaned task recovery (`recoverOrphanedTasks`) -> prerequisite task (`depends_on`) completion check -> atomic claiming (`tryClaimTask`).
    - In `claim_only` mode (`LIGHT` mode default), returns per-task delegation prompts and allowed files (automatically including `tests/**`) and creates subagent log folders.
    - In `parallel_spawn` mode (`HEAVY` mode), creates per-task Git worktrees, spawns external harness CLIs in parallel, and executes verification, merging, escalation (up to 3 attempts), and automatic Cross-Scope follow-up task creation (up to 2 per subagent).
  - [`handleVerify(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L1255-L1520): Verifies task file boundaries, secrets, and test commands, performing a checkpoint commit (`LIGHT`) or worktree merge (`HEAVY`) upon pass, and generates `.asd/summary.md` once all tasks are `done`.
  - [`handleDebate(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L1525-L1660): Runs `runDebateBroker`, stores heterogeneous model blind debate results in the DB, and injects constraints into the target task's `acceptance`.
- **[`src/mcp/stdio-rpc.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/stdio-rpc.ts)**:
  - `StdioRpcServer`: Newline-delimited JSON-RPC 2.0 stdio server implementation.

---

### 4.5 CLI & Local Web Dashboard (`src/cli/`)

#### 1. [`src/cli/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts)
Entrypoint for the `asd` terminal command.
- Supported subcommands: `sync`, `update`, `status`, `resume`, `handoff`, `migrate`, `plan`, `dispatch`, `verify`, `debate`, `logs`, `ui`, `doctor`, `clean`, `uninstall`, `hook`, `mcp`.
- [`runHookCli(hookType, flags)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts#L530-L710): Receives `session-start`, `pre-invocation`, `pre-tool-use`, and `stop` hook calls from the 5 harnesses, updates `cli-recent.json`, and returns policy evaluation results in each harness's expected JSON schema.
- [`runAsdResume(projectRoot, flags)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts#L715-L790): Demotes (`demoteAsdSession`) the active ASD session and immediately launches (or outputs with `--print`/`--json`) the original harness's interactive CLI.
- [`runAsdHandoff(projectRoot, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts): Generates (or prints with `--print`) a secret-redacted `handoff.md` document containing active session state and Git/task context.
- [`runAsdMigrate(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts): Automatically consolidates legacy per-hash `core.db` files into the single shared `~/.asd/state/core.db` (supports `--clean-legacy`).

#### 2. [`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts) (`asd ui` Specification)
Real-time local web dashboard (`http://127.0.0.1:3847`, default language `'en'` across all locales with persistent `'ko'` toggle via `localStorage`) powered purely by `node:http` and a single inline HTML/CSS/JS bundle without external frontend build tools. Starting in v2.4.3, data services (`collectDashboardSnapshot`, `discoverHarnessModels`, `saveSessionMemo`, `saveProjectRoutingConfig`, `runSubagentControlAction`, `scanSubagentLogs`) were migrated to `src/core/` (`models.ts`, `session-services.ts`, `subagent-control.ts`, `subagent-logs.ts`, `router.ts`), leaving this module dedicated solely to the HTTP server and UI rendering.
- **HTTP Endpoint -> Core Service Mapping**:
  - `GET /api/state` -> [`collectDashboardSnapshot()`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-services.ts) (`core/session-services.ts`): Unified snapshot of sessions, tasks, debates, drivers, subagent logs, routing, and harness states (`worktreeStatusCache` 3.5s TTL, supports `skipCliSpawn` option).
  - `GET /api/models`, `POST /api/models/refresh` -> [`discoverHarnessModels()`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/models.ts) (`core/models.ts`): Parallel 5-harness model discovery + `~/.asd/state/models-cache.json` (10m TTL).
  - `POST /api/session-memo` -> `saveSessionMemo()` (`core/session-services.ts`): Simultaneously updates `sessions.memo` and `main.json`.
  - `POST /api/routing` -> `saveProjectRoutingConfig()` (`core/router.ts`): Saves or resets project-scoped `.asd/routing.jsonc`.
  - `POST /api/subagent-action` -> `runSubagentControlAction()` (`core/subagent-control.ts`): Runtime control (`kill`/`retry`/`fallback`/`custom`).
  - [`startDashboardServer(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts): Starts the local HTTP server (not exported from the root SDK entry; dedicated to subpath `cli/dashboard`).

---

## 5. Known Architectural Notes & Operational Caveats

1. **Cursor CLI Local Transcript Limitation**:
   - Unlike other harnesses, Cursor CLI (`agent` / `cursor-agent`) does not expose plaintext JSONL transcript files on disk. Consequently, `readHarnessTranscript` returns `{ unsupported: true, messages: [] }` for Cursor, and ASD instead controls Cursor sessions via `~/.cursor/hooks.json`-based session ID tracking (`cli-recent.json`), live streaming turns (`runDriverTurn` `--output-format stream-json`), and session promotion/demotion (`promoteCliSessionToAsd` / `demoteAsdSession`).
2. **Concurrent Multiple Directors Within a Single Project**:
   - Although the SQLite DB is safe under concurrent access via WAL + `BEGIN IMMEDIATE` and the `session_drivers` table, and `HEAVY` merges are protected by `.asd/merge.lock`, running two `LIGHT`-track directors that directly edit files simultaneously in the same working tree can cause Git working-tree contention. Use the `HEAVY` track (worktree isolation) for parallel execution.
3. **JSDoc Comments Under Node.js Native TypeScript Execution**:
   - Because harness `PreToolUse` hooks directly invoke `node --no-warnings src/cli/index.ts hook pre-tool-use`, writing path globs containing `/*` or `*/` (e.g., `projects/*/*.jsonl`) inside `/** ... */` block comments in `src/` files can prematurely terminate the comment and trigger syntax errors. Use placeholders such as `projects/<dir>/*.jsonl` inside block comments.
4. **Core-GUI Boundary Principle (v2.4.3)**:
   - Core retains only **CLI + core management (planning, `asd ui` dashboard, git worktree, etc.) + minimal SDK/API**, while all rich UI, server, and rendering development belongs in the GUI repository (`asd-gui`). `asd ui` is feature-frozen (no expansion), and new UI features are implemented in the GUI repository. See [`docs/CORE_GUI_BOUNDARY_AUDIT.md`](./docs/CORE_GUI_BOUNDARY_AUDIT.md) for boundary violation cleanup details and rationale.
