# ASD v2.7.0 External SDK, Harness Storage & DB Reference (`EXTERNAL_SDK_REFERENCE.md`)

> **Version**: `2.7.0` (built on the single shared DB `~/.asd/state/core.db` — includes zero-dependency ACP v1/v2 client, first-class OpenCode V2 support + frozen V1 isolation, modular `src/orchestrator/`, v2.6.0 SDK dead-surface cleanup, and hardened blind debate engine — DB-incompatible with `<= 2.3.x`)  
> **Audience**: External application and library integration developers, including [**ASD-Nexus (`asd-gui`)**](https://github.com/N3wbie123/ASD-Nexus)  
> **Runtime Dependencies**: `0` (`dependencies: {}`, uses only pure Node.js `>=22.13.0` built-in modules)  
> **Main Entrypoint**: [`src/index.ts`](./src/index.ts) (`import { ... } from "agent-swarm-director"`)

**English** | [한국어](./EXTERNAL_SDK_REFERENCE_ko.md) | [📖 README](./README.md) | [🖥️ ASD-Nexus (Official GUI)](https://github.com/N3wbie123/ASD-Nexus) | [⚡ ACP Roadmap](./docs/ACP_ROADMAP.md) | [🏛️ Architecture](./PROJECT_STATUS.md) | [🤖 AI Workflow Prompt](./AI_WORKFLOW_PROMPT.md) | [📋 Patch Notes](./PATCH_NOTES.md)

---

## 1. Single Shared State DB Migration & Core Changes in v2.4.0

### 1.1 Migration to Single Shared SQLite DB (`~/.asd/state/core.db`)
Previously (`<= v2.3.2`), ASD created a separate `~/.asd/state/<projectHash>/core.db` for every project, which could accumulate thousands of hash directories over time (e.g., from temporary test projects). Starting in `v2.4.0`, ASD uses a **single shared DB (`~/.asd/state/core.db`)** architecture.

> [!IMPORTANT]
> **Legacy (`<= v2.3.2`) DB Auto-Recovery & Migration Tool (`asd-db-migrate.mjs`)**:  
> If you need to migrate legacy (`<= v2.3.2`) per-hash database data (`~/.asd/state/<projectHash>/core.db`) into the `v2.4.0` single shared DB (`~/.asd/state/core.db`) or repair corrupted columns, you can run `asd migrate [--clean-legacy]` or download and run the standalone migration tool below:  
> 👉 **[Download `asd-db-migrate` from Google Drive](https://drive.google.com/drive/u/0/folders/1knUQzIY8HDzIKYkxrhsCxgorQDn_B3nU)** (`node asd-db-migrate.mjs`)

| Category | Legacy (`<= v2.3.2`) | Current (`v2.4.0+`) |
| :--- | :--- | :--- |
| **DB File Location** | `~/.asd/state/<projectHash>/core.db` x N files | **Single `~/.asd/state/core.db` file** |
| **Project Scoping** | Separate hash directories | `sessions.project_root` column scoping (`SqliteDriver(dbPath, projectRoot?)`) |
| **Project Discovery** | Traverse thousands of directories + open N DBs | Single query in `listKnownProjects()` + 15s FS cache (`skipDiskCheck` supported) |
| **Test Home Isolation** | Varied per call site | Single resolution point via `ASD_HOME_DIR` env var ([`resolveHomeDir`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L102-L108)) |

#### Mandatory Checklist for External GUI (`asd-gui`) Integrations
1. **Prefer [`openProjectDb(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L1030-L1040)**: The returned [`SqliteDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L288-L1025) instance is already scoped to `projectRoot`, so calls to `listSessions()`, `getAllTasks()`, `getAllDebates()`, and `getLatestSession()` automatically return only that project's data.
2. **Caution When Calling `new SqliteDriver(dbPath)` Directly**: Omitting the second argument (`projectRoot`) queries sessions across all projects. When querying a specific project, always pass `new SqliteDriver(dbPath, projectRoot)` or use `openProjectDb(projectRoot)`.
3. **Role of `projectHash`**: `projectHash` on `resolveAsdPaths()` and `KnownProjectSummary` remains available as a stable UI list key (`key={p.projectHash}`), but the actual database file path must always reference `paths.dbPath` (`~/.asd/state/core.db`).

### 1.2 Summary of New & Enhanced v2.4.0 SDK APIs
1. **Unified 5-Harness CLI Session Discovery per Project ([`discoverProjectCliSessions`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1774-L1895))**:
   - Discovers all CLI sessions executed in the current project path across Claude Code, OpenCode, Codex, Antigravity, and Cursor, joined with ASD session promotion state (`isPromotedToAsd`, `asdSessionId`, `asdPhase`).
2. **4-Category Structured Transcript Parsing ([`readHarnessTranscript`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L995-L1084))**:
   - Reads transcripts from each harness's local DB/files and separates messages into **1. Thinking (`thinking`), 2. Tool Use (`tool_use`), 3. Tool Result (`tool_result`), and 4. Assistant (`assistant`) & User (`user`) messages**.
3. **Live Streaming Turn Execution ([`runDriverTurn`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L926-L1196) & [`parseDriverStreamLine`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L583-L920))**:
   - Relays user messages to the active harness and streams real-time Thinking steps, Tool Use invocations, Tool Results, and response text via the `onEvent` callback.
4. **Bidirectional Plain CLI Session <-> ASD Session Promotion & Demotion**:
   - **Promote**: [`promoteCliSessionToAsd`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1619-L1740) immediately promotes a plain CLI session into an ASD session (idempotent + automatic driver attachment).
   - **Demote**: [`demoteAsdSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1455-L1545) (or CLI `asd resume`) pauses an ASD session and returns immediately to the original harness's native interactive CLI session.
5. **Fast Initial Loading & Model Discovery Caching**:
   - [`discoverHarnessModels`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L225-L470): Asynchronous parallel probing (`Promise.all`) backed by a 10-minute TTL disk cache at `~/.asd/state/models-cache.json`.
   - [`listKnownProjects`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1901-L1980): Added 15-second in-memory FS stat cache, `skipDiskCheck`, and `db` instance reuse options.

---

## 2. Detailed Usage of Key v2.4.0 SDK APIs

### 2.1 Unified 5-Harness CLI Session Discovery (`discoverProjectCliSessions`)

Scans all local CLI sessions across the 5 harnesses executed in a given project path (including `syncLocalHarnessTranscripts`), matches them against ASD sessions in `core.db`, and returns them sorted newest-first.

```ts
import {
  discoverProjectCliSessions,
  type DiscoveredCliSession,
  type DiscoverProjectCliSessionsOptions,
} from "agent-swarm-director";

const sessions: DiscoveredCliSession[] = discoverProjectCliSessions("/path/to/project", {
  limit: 100,
  syncLocalTranscripts: true, // Default true: includes local storage scan for Claude/Codex/OpenCode/Antigravity
});
```

#### `DiscoveredCliSession` Return Shape
| Field | Type | Description |
| :--- | :--- | :--- |
| `harness` | `HarnessId` | `"claude-code" \| "opencode" \| "codex" \| "antigravity" \| "cursor"` |
| `harnessSessionId` | `string` | Native harness session ID (UUID, etc.) |
| `projectRoot` | `string` | Normalized project root path |
| `updatedAt` | `number` | Last activity timestamp (Unix epoch ms) |
| `model` | `string \| undefined` | Detected model ID |
| `summary` | `string \| undefined` | First user prompt or summary title of the session |
| `transcriptPath` | `string \| undefined` | Local transcript file (`.jsonl`) or `opencode.db` path |
| `asdSessionId` | `string \| null` | Promoted ASD `session_id` (`null` for unpromoted plain CLI sessions) |
| `asdPhase` | `SessionPhase \| null` | `"planning" \| "running" \| "paused" \| "done" \| null` |
| `isPromotedToAsd` | `boolean` | `true` if promoted to an ASD session and registered in `core.db` |

---

### 2.2 4-Category Transcript Parser (`readHarnessTranscript`)

Reads conversation history from each harness's local transcript storage and classifies entries into **Thinking**, **Tool Use**, **Tool Result**, and **User / Assistant messages**.
- **Claude Code**: Separates `thinking`, `tool_use`, `tool_result`, and `text` blocks from `~/.claude/projects/<encoded>/*.jsonl`.
- **Codex CLI**: Separates `agent_reasoning`, `function_call`, `custom_tool_call`, `function_call_output`, `user_message`, and `agent_message` from `~/.codex/sessions/**/<id>.jsonl`.
- **OpenCode**: Separates the `part` table (`reasoning`, `tool`, `text`) in `~/.local/share/opencode/opencode.db` and JSON storage.
- **Antigravity**: Separates `USER_INPUT`, `PLANNER_RESPONSE` (`thinking`, `tool_calls`), and `TOOL_RESPONSE` in `transcript.jsonl`, automatically restoring untruncated lines from `transcript_full.jsonl` when `truncated_fields` occurs.

```ts
import {
  readHarnessTranscript,
  type TranscriptReadResult,
  type TranscriptMessage,
  type TranscriptMessageCategory,
} from "agent-swarm-director";

const transcript: TranscriptReadResult = readHarnessTranscript({
  harness: "claude-code", // "claude-code" | "opencode" | "codex" | "antigravity" | "cursor"
  projectRoot: "/path/to/project",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  transcriptPath: undefined, // Optional: pass directly if known to skip disk lookup
  maxMessages: 300,
});
```

#### `TranscriptMessage` Interface (v2.4.0)
```ts
export type TranscriptMessageCategory =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system";

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  category?: TranscriptMessageCategory;
  text: string;
  thinking?: string; // Raw reasoning text when category === "thinking"
  toolName?: string;
  toolUse?: {
    name: string;
    id?: string;
    input?: string;  // Tool call arguments as a JSON string
  };
  toolResult?: {
    name?: string;
    toolUseId?: string;
    output: string;  // Tool execution output text
    isError?: boolean;
  };
  timestamp?: string;
}
```

---

### 2.3 Live Streaming Conversation Execution (`runDriverTurn`, `parseDriverStreamLine`)

Forwards a user message from a chat interface to the target harness and receives real-time **Thinking steps**, **Tool Use calls**, **Tool Results**, and **Assistant response text** via the `onEvent` callback.

```ts
import {
  openProjectDb,
  runDriverTurn,
  cancelDriverTurn,
  closeDriverSession,
  closeAllDriverSessions,
  type DriverStreamEvent,
  type DriverRunResult,
} from "agent-swarm-director";

const db = openProjectDb("/path/to/project");
const controller = new AbortController();

const result: DriverRunResult = await runDriverTurn({
  projectRoot: "/path/to/project",
  db,
  sessionId: "asd-20261103-182153-i9ti",
  prompt: "Analyze the session tracker architecture in the current project.",
  model: "claude-sonnet-4-6",   // Optional: override driver.model / default model (switches via setSessionModel in ACP sessions)
  transport: "auto",            // "auto" (default: ACP first, CLI fallback on failure) | "acp" | "cli"
  autoApprove: false,           // When false, interactive permission confirmation is delegated to onPermissionRequest (defaults to session.auto_approve)
  onPermissionRequest: async (params) => {
    const allowOpt = params.options?.find((o) => o.kind === "allow_once");
    return allowOpt
      ? { outcome: { outcome: "selected", optionId: allowOpt.optionId } }
      : { outcome: { outcome: "cancelled" } };
  },
  signal: controller.signal,    // Trigger cooperative cancellation (ACP session/cancel) via AbortSignal
  streamJson: true,             // Enable NDJSON streaming when using the CLI transport path
  onEvent: (event: DriverStreamEvent) => {
    switch (event.type) {
      case "thinking":
        console.log("[Live Thinking]", event.thinking);
        break;
      case "tool_use":
        console.log("[Live Tool Use]", event.toolName, event.toolInput);
        break;
      case "tool_result":
        console.log("[Live Tool Result]", event.toolOutput);
        break;
      case "text":
        console.log("[Live Assistant Response]", event.text);
        break;
    }
  },
});

// Resident ACP turn control & session pool cleanup helpers
cancelDriverTurn("asd-20261103-182153-i9ti"); // Send session/cancel to an active ACP turn
await closeDriverSession("asd-20261103-182153-i9ti"); // Close the resident ACP client for this session
await closeAllDriverSessions(); // Close all resident ACP sessions in the pool
```

#### Key `RunDriverTurnInput` ACP, Permission & Lifecycle Options
| Option / Helper | Type / Signature | Description |
| :--- | :--- | :--- |
| `transport` | `"auto" \| "acp" \| "cli"` | `"auto"` (default, or `"cli"` when `commandRunner` is specified): prefers resident ACP session execution and falls back to CLI on Phase-A failure. `"acp"` throws an error if ACP is unsupported or fails |
| `model` | `string \| null` | Model override for turn execution (switches via `setSessionModel` when reusing a resident ACP pool entry) |
| `autoApprove` | `boolean` | When `true`, auto-approves ACP permission requests; when `false`, delegates to `onPermissionRequest` (protected paths are always blocked first by the core guard) |
| `onPermissionRequest` | `(params: AcpRequestPermissionParams) => Promise<AcpRequestPermissionResult>` | Async callback returning the `session/request_permission` response when `autoApprove: false` |
| `cancelDriverTurn` | `(sessionId: string) => boolean` | Sends `session/cancel` to an active ACP turn for the session (same effect as `signal?: AbortSignal`) |
| `closeDriverSession` | `(sessionId: string) => Promise<void>` | Removes and terminates only the resident ACP client attached to the specified session |
| `closeAllDriverSessions` | `() => Promise<void>` | Cleans up all resident ACP clients on application shutdown |

---

### 2.4 ASD Session Management: Promote (`promoteCliSessionToAsd`) & Demote (`demoteAsdSession`)

#### 1. Promote a Plain CLI Session to an ASD Session (Promote)
```ts
import {
  promoteCliSessionToAsd,
  type PromoteCliSessionResult,
} from "agent-swarm-director";

const promoted: PromoteCliSessionResult = promoteCliSessionToAsd({
  projectRoot: "/path/to/project",
  homeDir: undefined,        // Optional: uses resolveHomeDir() when omitted
  harness: "claude-code",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  model: "claude-sonnet-4-6",
  title: "Session promoted from GUI",
  memo: "Session promoted from GUI",
  transcriptPath: undefined, // Optional: local transcript file path
  makeForeground: true,      // When true, immediately sets as the foreground session in .asd/PLAN.md
  source: "gui",             // "gui" | "cli" (default "gui")
  db: undefined,             // Optional: inject an already-open SqliteDriver instance
});
// promoted.sessionId / promoted.asdSessionId -> promoted ASD session_id (identical value)
// promoted.created                           -> whether newly created (false if already promoted, reusing existing session)
// promoted.driver                            -> attached active DriverRow
// promoted.session                           -> created or reused SessionRow
```

#### 2. Demote an ASD Session Back to a Native Harness CLI Session & Unlink (`buildSessionDemotion`, `unlinkHarnessSessionFromAsdSession`)
```ts
import {
  buildSessionDemotion,
  unlinkHarnessSessionFromAsdSession,
  type SessionDemotionResult,
} from "agent-swarm-director";

// 1. Build interactive terminal resume command (identical to asd resume; supports session.harness_session_id fallback even without an active driver)
const demoted: SessionDemotionResult = buildSessionDemotion({
  projectRoot: "/path/to/project",
  sessionId: "asd-20261103-182153-i9ti",
});
// demoted.cliString -> 'claude --resume "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"'

// 2. Detach driver from the ASD session and reset asdSessionId to null in cli-recent.json to restore plain CLI session state
const unlinked = unlinkHarnessSessionFromAsdSession({
  projectRoot: "/path/to/project",
  asdSessionId: "asd-20261103-182153-i9ti",
  deleteAsdSession: false, // Pass true to cascade-delete the ASD session and its tasks/drivers from core.db
});
```

---

### 2.5 Fast Project Loading & Model Cache APIs (`listKnownProjects`, `discoverHarnessModels`)

```ts
import {
  listKnownProjects,
  discoverHarnessModels,
  getModelsDiskCachePath,
} from "agent-swarm-director";

// 1. Fast project list lookup (applies 15s FS stat cache; skipDiskCheck: true queries DB immediately with zero disk stat I/O)
const projects = listKnownProjects({
  skipDiskCheck: false,
  forceRefresh: false,
});

// 2. Asynchronous parallel model discovery (uses 10-minute disk cache at ~/.asd/state/models-cache.json)
const models = await discoverHarnessModels(false); // Pass true to force refresh
const cachePath = getModelsDiskCachePath();
```

---

## 3. Full Externally Callable Interface Catalog

### 3.1 Node.js Library Subpath Exports (`package.json` `exports`)

```ts
import * as asd from "agent-swarm-director";                       // Unified root core entry (src/index.ts)
import * as db from "agent-swarm-director/core/db";                // Direct core submodule import
import * as orch from "agent-swarm-director/orchestrator/index";   // Modular CLI orchestrator
import * as dashboard from "agent-swarm-director/cli/dashboard";   // Local `asd ui` server (subpath-only)
```

| Module Path | Key Exported Functions & Classes |
| :--- | :--- |
| **`core/types`** | `ASD_VERSION` (`"2.7.0"` — derived at runtime from `package.json`), `HARNESS_IDS`, `AGENT_ROLES`, `TASK_CATEGORIES`, `DIFFICULTY_TIERS`, `TASK_TRACKS` (`"DIRECT" \| "LIGHT" \| "HEAVY"`), `TASK_STATUSES`, `SESSION_PHASES`, `DRIVER_SOURCES`, and all core TypeScript interfaces |
| **`core/acp-types` & `core/acp-client`** *(v2.7.0)* | Zero-dependency ACP v1/v2 JSON-RPC stdio client: `AcpStdioClient`, `probeAcpCapability`, `executeAcpSubagentTurn`, `resolveBestAcpModelId`, `checkInteractivePermissionSafety` |
| **`core/config`** | `resolveAsdPaths(root, home?)`, `resolveHomeDir(explicit?)`, `ensureProjectInitialized`, `loadRoutingConfig`, `loadMcpCatalog`, `checkForRemoteUpdate`, `computeProjectHash` |
| **`core/opencode-profile`** *(v2.7.0)* | `detectOpenCodeProfile` — OpenCode V2 (`2.x`, first-class) vs Legacy V1 (`1.x`, frozen) capability detection |
| **`core/db`** | `openProjectDb(root, home?)`, `SqliteDriver(dbPath, projectRoot?)`, `generateAsdSessionId`, `isValidAsdSessionId` — `findSessionByHarnessSessionId`, `deleteSession`, `injectDebateAcceptance`, and full CRUD across `sessions` / `tasks` / `debates` / `session_drivers` |
| **`core/session-tracker`** | `discoverProjectCliSessions`, `promoteCliSessionToAsd`, `unlinkHarnessSessionFromAsdSession`, `buildSessionDemotion`, `listKnownProjects`, `syncLocalHarnessTranscripts`, `linkHarnessSessionToAsdSession`, `readCliRecentSessions`, `recordCliRecentSession`, `buildSpawnSpec`, `buildHeadlessHarnessCommand`, `buildResumeHarnessCommand` *(options-object form only since v2.6.0)*, `buildInteractiveResumeHarnessCommand`, `extractHookSessionInfo` |
| **`core/drivers`** | `runDriverTurn` *(resident ACP session pool + native JSONL CLI fallback)*, `cancelDriverTurn`, `closeDriverSession`, `closeAllDriverSessions`, `parseDriverStreamLine`, `attachDriver`, `detachDriver`, `getActiveDriver`, `listDrivers`, `buildDriverBriefing`, `syncSessionDriversToMainJson` |
| **`core/transcripts`** | `readHarnessTranscript` *(4-category parser across Claude, OpenCode V1/V2 `session_v2`, Codex `.jsonl`/`.jsonl.zst`, Antigravity, and Cursor lossy fallback)*, `locateHarnessTranscript` |
| **`core/spawner`** | `spawnSubagent`, `executeHarnessProcess`, `killProcessTree`, `resolveSpawnCommand`, `finalizeSubagentArtifacts` |
| **`core/router`** | `resolveRoute`, `runWithFallbacks` *(optional `maxRetries` cap)*, `escalateTaskRoute`, `resolveFallback`, `detectAvailableCliHarnesses`, `detectLiveRuntimeCapabilities`, `selectDiverseReviewer` *(optional cumulative `excludedFamilies`)*, `resolveLightSubagentRoute`, `saveProjectRoutingConfig` |
| **`core/models`** | `discoverHarnessModels`, `getModelsDiskCachePath` |
| **`core/session-services`** | `saveSessionMemo`, `collectDashboardSnapshot` |
| **`core/subagent-control`** | `runSubagentControlAction` |
| **`core/subagent-logs`** | `scanSubagentLogs`, `SubagentLogRecord` |
| **`core/workspace`** | `prepareBaseline`, `createTaskWorktree`, `verifyAndCommitLightTask`, `verifyAndMergeHeavyTask`, `approvePendingTask`, `rejectPendingTask`, `rollbackLightChanges`, `recoverOrphanedTasks`, `isPidAlive`, `verifyPidIdentity`, `getChangedFiles`, `checkChangedFilesAndSecrets`, `withMergeLock`, `runGit` |
| **`core/render`** | `renderPlanMd`, `parsePlanMd`, `syncPlanFromMd`, `setForegroundSession`, `getForegroundSessionId`, `renderProgressBoard`, `renderSessionSummaryMd`, `atomicWriteFileSync` |
| **`core/debate`** | `runDebateBroker` *(hybrid ACP + streaming CLI, `REJECT` DB/PLAN isolation, Arbiter sole authority, post-run `diversityDegraded` recomputation)*, `parseReviewerOpening`, `synthesizeInsightVerdict`, `buildDebateCodeContext`, `buildRound2CitedCodeContext`, `buildRound1Prompt` *(optional `role`)*, `buildRound2Prompt`, `formatDebateAcceptance` |
| **`core/policy`** | `evaluatePreToolUse`, `evaluateStopHook`, `resolveSafeTargetPath`, `isPathAllowed`, `checkProtectedPath`, `verifyChangedFilesBoundary` |
| **`core/redact` & `jsonc`** | `redactSecrets`, `containsSecrets`, `parseJsonc`, `stripJsoncComments`, `upsertTomlFencedBlock`, `removeTomlFencedBlock` |
| **`adapters/*`** | `ClaudeCodeAdapter`, `OpenCodeAdapter` (V2 default + frozen `opencode-v1.ts`), `CodexAdapter`, `AntigravityAdapter`, `CursorAdapter`, `syncHarnessConfigs`, `uninstallGlobalConfigs`, `runAsdDoctor`, `createHarnessProvisionerPlugin`, `createHarnessRuntimePlugin`, `registerDefaultHarnessPlugins` |
| **`orchestrator/*`** *(v2.7.0)* | `AsdOrchestrator`, `PLAN_SCHEMA_DEFINITION`, `handlePlan`, `handleDispatch`, `handleVerify`, `handleDebate`, `buildEscalationHint`, `detectRoleCategoryWarnings`, `findOverlappingLightTargetFiles`, `parseSubagentReport` |
| **`cli/dashboard`** | `startDashboardServer` *(subpath-only `agent-swarm-director/cli/dashboard` — `asd ui` local server+UI; feature-frozen)* |
| **`cli/index`** | `getAdapter`, `getLatestSession`, `runAsdLogs`, `runAsdClean` |

---

### 3.2 CLI Subcommands (`asd <command>`)

Common flags: `--json`, `--project-root <dir>`, `--home <dir>`, `--session <id>`, `--harness <id>`.

| Command | Description | Key Flags |
| :--- | :--- | :--- |
| `asd plan [create\|get\|update\|sync_from_md\|schema]` | Create, query, update, reverse-sync `.asd/PLAN.md` and SQLite tasks, or print canonical JSON schema | `--tasks <json>`, `--payload <json\|->`, `--file <path>`, `--track <DIRECT\|LIGHT\|HEAVY>` |
| `asd dispatch` | Execute or claim Turn (Wave) tasks in parallel (ACP-first + CLI fallback) | `--turn <n>`, `--mode parallel_spawn\|claim_only`, `--async`, `--transport <auto\|acp\|cli>`, `--task T1.1` |
| `asd wait` | Wait for an active `asd dispatch --async` wave to complete | `--session <id>`, `--timeout <ms>`, `--json` |
| `asd verify --task <id>` | Verify file boundaries, secrets, and tests, then commit (`DIRECT`/`LIGHT`) or merge worktree (`HEAVY`) | `--summary`, `--files`, `--cmd`, `--file <path>` |
| `asd debate --topic <t> --proposal <p>` | Run cross-model blind adversarial debate and auto-inject non-`REJECT` constraints into `acceptance` | `--proposal-file`, `--task` / `--task-id`, `--harnesses`, `--roles`, `--count`, `--diff`, `--files path:start-end` |
| `asd resume` | Demote active ASD session and return immediately to the original harness's interactive CLI | `--session <id>`, `--print`, `--json` |
| `asd status` | Print the current project's foreground session live `progressBoard` (English default) | `--json` |
| `asd logs [taskId]` | Inspect subagent prompt and output logs for the latest or specified task | `--json` |
| `asd ui` | Launch the local real-time web dashboard server (default port `3847`, feature-frozen) | `--port <num>`, `--no-open` |
| `asd sync` | Synchronize global skills, agents, hooks, and external MCP catalog across all 5 harnesses and register on `PATH` | `--force`, `--refresh-models`, `--no-model-probe`, `--no-path` |
| `asd update` | Pull latest version from GitHub and automatically run `asd sync` | — |
| `asd doctor` | ~10ms environment, harness, ACP readiness, and security hook health check | `--json` |
| `asd migrate` | Import legacy per-hash `core.db` files (`<= v2.3.2`) into `~/.asd/state/core.db` | `--clean-legacy`, `--json` |
| `asd clean` | Clean leftover `.asd/wt/*` worktrees, restore auto-stashed changes, or purge orphans | `--pop`, `--all`, `--purge-orphans` |
| `asd uninstall` | Surgically revert only ASD-installed global configurations | `--home <dir>` |
| `asd hook <type>` | Harness hook evaluator (`session-start`, `pre-invocation`, `pre-tool-use`, `stop`) | stdin JSON -> stdout JSON |

---

### 3.3 Local Web Dashboard HTTP API (`asd ui`, default `http://127.0.0.1:3847`)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/state` | `GET` | Return full state snapshot from `collectDashboardSnapshot()` |
| `/api/models` | `GET` | Query available models across all 5 harnesses (backed by `models-cache.json`) |
| `/api/models/refresh` | `POST` | Force re-discovery of harness models (`discoverHarnessModels(true)`) |
| `/api/session-memo` | `POST` | Save a short session memo (`{ sessionId, memo }`) |
| `/api/routing` | `POST` | Save or reset project-local routing (`.asd/routing.jsonc`) (`{ action: "save" \| "reset", routingConfig }`) |
| `/api/subagent-action` | `POST` | Real-time subagent control (`{ sessionId, subSessionId, action: "kill" \| "retry" \| "fallback" \| "custom", harness?, model? }`) |

---

## 4. 5-Harness Storage, Streaming Schemas & Operational Caveats

All 5 harnesses are normalized behind the same 3-stage SDK pipeline (`discoverProjectCliSessions` → `readHarnessTranscript` → `runDriverTurn` + `parseDriverStreamLine`), emitting unified `DriverStreamEvent` objects (`thinking` / `tool_use` / `tool_result` / `text` / `raw`). Client applications should consume these normalized events rather than branching per harness or assembling CLI flags manually.

### 4.1 Per-Harness Reference Matrix

| Harness | Local Session Storage | Primary Transport / Streaming | Empirical Event Flow & Key Caveats |
| :--- | :--- | :--- | :--- |
| **Claude Code (`@cc`)** | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` *(unstable schema — always use `readHarnessTranscript`)* | ACP bridge (`@agentclientprotocol/claude-agent-acp`) or CLI `claude -p ... --output-format stream-json --verbose --include-partial-messages` | `system/init` → `stream_event` (`content_block_delta`: `text_delta`/`thinking_delta`/`input_json_delta`) → `assistant` → `user` (`tool_result`) → `result`. Pass long prompts via `stdin`; built-in defense against JSONL schema drift. |
| **OpenCode (`@oc`)** | `~/.local/share/opencode/opencode.db` (SQLite WAL — `session_v2` / `session_message` / `session_part` on V2; `session` / `message` / `part` on frozen V1). Check via `opencode debug paths db`. | **Native ACP** (`opencode acp` on V2; `--pure` on Legacy V1) or CLI `opencode run ... --format json` (V2 adds `--auto`) | Block/part events (`step_start` → `text` → `step_finish`) or ACP `session/update` deltas. Always run session-ID-scoped queries on the multi-GB DB; session IDs always use `ses_` prefix (self-healed against Claude hook mirror misattribution). |
| **Codex CLI (`@cx`)** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (older `.jsonl.zst` transparently decompressed via `node:zlib` / `zstd`) | ACP bridge (`@agentclientprotocol/codex-acp`) or CLI `codex exec ... --json` | `thread.started` → `turn.started` → `item.started\|completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`) → `turn.completed`. **Always close `stdin`** in piped environments to avoid hanging. |
| **Antigravity (`@ag`)** | `~/.gemini/antigravity-cli/conversations/<id>.db` + `brain/<id>/.system_generated/logs/transcript.jsonl` (auto-restores `truncated_fields` from `transcript_full.jsonl`) | **Native ACP** (`agy acp`) or CLI `agy -p ... --output-format stream-json` | `init` → `step_update` (`text_delta`, ~25ms token deltas) → `result` (`result.response`). Deduplicate `result.response` against accumulated `text_delta` (built into ASD). Resume via `--conversation <id>`. |
| **Cursor CLI (`@cr`)** | `~/.cursor/chats/<workspace-md5>/<chat-uuid>/store.db` *(proprietary blob — native store returns `unsupported`, backed by lossy JSONL fallback at `~/.asd/transcripts/cursor/<id>.jsonl`)* | **Native ACP** (`cursor-agent acp`) or CLI `cursor-agent -p ... --force --output-format stream-json` | `system/init` → **`user` prompt echo (skipped automatically)** → `thinking` (`subtype: "delta"`) → `tool_call` (`started\|completed`, `tool_call.<family>ToolCall.result.success\|error.errorMessage`) → `assistant` → `result`. On Windows, `.ps1` wrappers are spawned via `powershell -File` / `.cmd` shims automatically. |

### 4.2 Core–Client Boundary Rules
- **Do not assemble harness CLI flags in client apps** — delegate to `runDriverTurn` / `buildSpawnSpec`.
- **Do not mutate `.asd/` directly** — use official SDK / `asd` CLI commands (`openProjectDb`, `asd plan`, `asd verify`, etc.).
- **Do not parse raw harness transcript files directly** — `readHarnessTranscript` absorbs schema drift, `.jsonl.zst` decompression, `transcript_full.jsonl` restoration, and `ses_` attribution guards.
