# ASD Orchestrator TUI/GUI App Development Plan

**English** | [한국어](./ORCHESTRATOR_APP_PLAN_ko.md)

> Date: 2026-11-06 · Basis: Empirical local measurements across 5 harnesses + official documentation survey + ASD v2.4.2 code verification
> Status: Planning (implementation not started)
> Update (2026-11-13, ASD v2.6.0 baseline): Updated snapshot and command-assembly locations in the Section 0 table to match the latest code. Adapter headless/resume/interactive builder methods were removed in v2.6.0, leaving the `buildSpawnSpec` family in `src/core/session-tracker.ts` as the single command-assembly path. Appendix B Gap 1 (`zstd`) is confirmed resolved. The GUI (including TUI) repository is being rewritten from scratch as ASD-Nexus.

---

## 0. Core Premise — Do Not Rebuild What Already Exists

Most of the core application logic is already implemented and shipped in ASD v2.4.2 (`asd-multiagent`).
The new application is **not a "new harness integration layer", but a "shell on top of the existing ASD SDK"**.

| Planned Capability | Existing Implementation | Location |
|---|---|---|
| Harness invocation + real-time streaming (`thinking`/`tool_use`/`tool_result`/`assistant`) | `runDriverTurn` + `parseDriverStreamLine` | `src/core/drivers.ts` |
| Session transcript loading (4-category parsing) | `readHarnessTranscript` | `src/core/transcripts.ts` |
| Automatic project session discovery | `discoverProjectCliSessions` | `src/core/session-tracker.ts` |
| ASD progress board | `renderProgressBoard`, `asd status --json` | `src/core/render.ts`, `src/cli/index.ts` |
| Full state snapshot | `collectDashboardSnapshot()` | `src/core/session-services.ts` |
| Web UI prototype | `asd ui` (`node:http`, `:3847`) | `src/cli/dashboard.ts` |
| Subsession spawning / logs | `spawnSubagent`, `scanSubagentLogs` | `src/core/spawner.ts` |
| Harness command assembly | `buildSpawnSpec` / `buildHeadlessHarnessCommand` / `buildResumeHarnessCommand` / `buildInteractiveResumeHarnessCommand` | `src/core/session-tracker.ts` |
| GUI Project | ASD-Nexus (`https://github.com/N3wbie123/ASD-Nexus`) | Separate repository |

---

## 1. Per-Harness Empirical Matrix

| Harness | Session Storage | Primary Streaming | Secondary Streaming (CLI Pipe) | Session Resume | Evidence |
|---|---|---|---|---|---|
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite WAL, single DB) | `opencode serve` + SSE `GET /api/event/subscribe` | `opencode run "..." --format json` | `-s <id>` / `-c` / `--fork`, `opencode export <id>` | Live demo run ✅ |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | Agent SDK `query({ resume, includePartialMessages })` | `claude -p --output-format stream-json --verbose --include-partial-messages` | Official simultaneous `--resume <id>` + streaming support, `--fork-session` | Stream events verified ✅ |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (legacy `.zst`) | `codex app-server` JSON-RPC (bidirectional, runtime approval supported) | `codex exec --json` | `codex exec resume <id>`, `codex fork` | **Full demo completed ✅** |
| Cursor CLI | `~/.cursor/chats/<workspace-md5>/<uuid>/store.db` (SQLite) + `meta.json` | `@cursor/sdk` (GA) | `cursor-agent -p --output-format stream-json --stream-partial-output` | `--resume <chatId>`, `create-chat` | Help + docs + storage verified |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<id>.db` + `brain/<id>/.system_generated/logs/transcript.jsonl` (→ `transcript_full.jsonl` fallback) | Python/Rust SDK | `agy -p --output-format stream-json`, `--input-format stream-json` (resident multi-turn) | `--conversation <id>`, `-c` | Help + docs + directory verified |

### Key Notes per Harness

- **OpenCode**: The TUI itself is a server client. Reuse a warm server via `run --attach http://localhost:4096` (avoids MCP cold boot). Official SDKs: `@opencode/sdk` (embedded) / `@opencode/client`.
- **Claude**: Stores all `thinking`/`tool_use`/`tool_result` entries in session JSONL. However, there is an **official warning that the format is unstable** → `readHarnessTranscript` parser requires ongoing maintenance. The Agent SDK can also control permission approval UI (`canUseTool`).
- **Codex**: `app-server` provides an `initialize` handshake → `thread/start|resume|fork`, `turn/start|steer|interrupt`, `item/agentMessage/delta` notifications, and approval RPC (`execCommandApproval`). Generate TypeScript bindings automatically via `codex app-server generate-ts`. Legacy `codex mcp` server was removed (`app-server` is its successor). Empirical pitfall: `stdin` must be closed in piped-stdin environments.
- **Cursor**: Under `--stream-partial-output`, events without `model_call_id` are true deltas, whereas events with `model_call_id` are buffer flushes (skip duplicates). IDE and CLI session stores are separate.
- **Antigravity**: Includes `agy acp` (ACP stdio JSON-RPC server). App (IDE) artifacts are Markdown files under `~/.gemini/antigravity/brain/<id>/task.md`, etc.

### Common Conclusion

All 5 harnesses **support real-time streaming purely by parsing child-process `stdout` JSONL**. OpenCode, Codex, and Claude additionally offer resident server/protocol paths. Session rendering (historical transcripts) is solved across all 5 by parsing stored files or SQLite databases.

---

## 2. Architecture — Core Server + 2 Clients (Adopting the OpenCode Pattern)

```
┌───────────────┐   SSE/HTTP    ┌──────────────────────────────────┐   Child Process
│  TUI Client   │ ────────────▶ │ Orchestrator Server (GUI Repo)   │ ──▶ claude -p --output-format stream-json
│  (Terminal)   │ ◀──────────── │  - Extends asd-gui src/server    │ ──▶ codex exec --json
└───────────────┘   SSE Events  │  - runDriverTurn (Core SDK)      │ ──▶ opencode run --format json
┌───────────────┐               │  - openProjectDb (core.db)       │ ──▶ agy -p --output-format stream-json
│  GUI Client   │ ────────────▶ │  - Event normalization/broadcast │ ──▶ cursor-agent -p --output-format stream-json
│ (Tauri/Electron)│ ◀────────── └──────────────────────────────────┘
└───────────────┘
```

- **Orchestrator Server (owned by the GUI repository)**: Extends `src/server` (HTTP+WS) in `asd-gui`. New endpoints: `/api/turn/stream` (POST: prompt → SSE normalized event push), `/api/sessions`, `/api/transcript/:harness/:id`, `/api/board`, `/api/subagents`.
- **Boundary Principle (confirmed 2026-11-06)**: Core (`asd-multiagent`) retains only **CLI + Core management (planning, `asd ui` dashboard, git worktree, etc.) + minimal SDK/API**, while all UI, server hosting, and rendering belong to the GUI repository. `asd ui` is feature-frozen (no further expansion — new UI features go to the GUI repo). For Core boundary violation cleanup, see [CORE_GUI_BOUNDARY_AUDIT.md](./CORE_GUI_BOUNDARY_AUDIT.md).
- **TUI**: Consumes the same SSE stream. **GUI**: Consumes the same SSE stream (keeping the webview thin). Recommended to evolve ASD-Nexus on top of this core server (the SDK is designed around `asd-gui` integration).

### Event Normalization Contract

```ts
type OrchestratorEvent = DriverStreamEvent & {
  kind: "thinking" | "tool_use" | "tool_result" | "text" | "status" | "usage" | "error";
  sessionId?: string;
  usage?: { input: number; output: number; cost?: number };
  status?: "running" | "done" | "interrupted";
};
```

Rendering rules (harness-agnostic): `thinking` = collapsible real-time append, `tool_use` = icon + name + args + spinner, `tool_result` = collapsible (red when `is_error`), `text` = incremental Markdown render, `usage` = turn footer.

### Approval (Permission) Handling

- v1: Auto-approve flags (`--auto`, `--dangerously-skip-permissions`, `--force`) — existing ASD approach.
- v2: Claude = Agent SDK `canUseTool`, Codex = `app-server` approval RPC, OpenCode = permissions API, Cursor = `--auto-review`.

### Recommended Stack

| Layer | Recommendation | Rationale |
|---|---|---|
| Core | Node 22+ TS, import `agent-swarm-director`, keep 0 dependencies | Import the SDK directly |
| TUI | Ink (React for CLIs) | Rapid implementation of chat stream + focus + scrolling. If lower priority, replace v1 with enhanced `asd ui` |
| GUI | Tauri + React (Alternative: Electron) | Thin webview thanks to separate core server. Electron is advantageous for reusing ASD-Nexus |

---

## 3. Automatic Session Loading + Subsession & Progress Monitoring

### 3.1 Automatic Loading When Opening a Main Session (3 Steps)

1. **Collect Session Candidates**: `openProjectDb(projectRoot)` → ASD session list + `discoverProjectCliSessions(projectRoot)` → batch discovery of all 5 harness CLI sessions (including promotion status).
2. **Restore Transcript**: `readHarnessTranscript({ harness, projectRoot, harnessSessionId })` → 4-category rendering.
3. **Continue Conversation**: From the next turn onward, `runDriverTurn` resumes via `session_drivers.harness_session_id` using the harness resume flag.

### 3.2 Real-Time Refresh Strategy

- File-backed (Claude JSONL / Codex rollout / Antigravity transcript): `chokidar` append detection → incremental parsing. **Legacy Codex `.zst` sessions require zstd decompression on load (identified gap).**
- DB-backed (OpenCode `opencode.db` 2.29GB / Cursor `store.db`): Session-ID-scoped queries only + 1–2s polling. For OpenCode, server SSE replaces polling.
- Claude JSONL format instability → per-version parser regression tests.

### 3.3 Hotkey Monitoring Panel (`Ctrl+B` Overlay)

| Section | Data Source (All Existing Implementations) |
|---|---|
| Progress Board | `asd status --json` → `progressBoard` |
| Subsession List | `collectDashboardSnapshot()` tasks + `session_drivers` |
| Subsession Live Logs | `scanSubagentLogs()` (real-time `output.log` append) + `sub_session_id` tail |
| HEAVY Mode | Inspect `.asd/wt/<turn>-<task>` + `getWorktreeDiff()` |
| Controls | `/api/subagent-action` (`kill`/`retry`/`fallback`/`resume`) |

Proposed keymap: `Ctrl+B` board, `Ctrl+L` logs, `Ctrl+D` diff. Refresh: 1s polling + log tailing while the panel is open.

---

## 4. Cross-Harness Seamless Continuation — Confirmed Excluded

Because session storage formats differ completely across harnesses, lossless migration offers poor value relative to cost. **Adopted the `/handoff` (`asd-handoff`) skill workflow ("summarize conversation → resume in any harness") as the standard mechanism**. No translation layer or new database will be created.

---

## 5. Implementation Sequence

- **M1**: Orchestrator server (in GUI repo, SSE streaming, 1 harness: Claude) + web chat view
- **M2**: Complete all 5 harness adapters + automatic session loading
- **M3**: Hotkey monitoring panel + approval UI (begin v2)
- **M4**: TUI shell → GUI packaging

---

## Appendix A. Empirical Evidence Excerpts

```
$ codex exec --json "Reply with exactly: OK" --skip-git-repo-check --sandbox read-only
{"type":"thread.started","thread_id":"01a1b12a-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":18720,...}}

$ opencode run "Reply with exactly: OK" --format json
{"type":"step_start",...,"sessionID":"ses_..."}
{"type":"text","part":{"type":"text","text":"OK",...}}
{"type":"step_finish","part":{...,"tokens":{...},"cost":0}}

$ claude -p "..." --output-format stream-json --verbose
{"type":"system","subtype":"init",...,"session_id":"...","tools":[...]}
{"type":"system","subtype":"api_retry",...}   <- Turn incomplete due to model proxy error; protocol itself verified
```

## Appendix B. Known Gaps & Risks

1. Legacy Codex sessions `.jsonl.zst` — requires `zstd` decompression when loading full history (**Confirmed Resolved**: `decompressZstdBuffer` in `core/transcripts.ts` automatically decompresses `.jsonl.zst` via `node:zlib` `zstdDecompressSync` + `zstd -dc` CLI fallback).
2. Claude session JSONL official "unstable format" — requires parser regression tests.
3. OpenCode `opencode.db` 2.29GB — never load in full; use session-scoped queries only.
4. Antigravity adapter not using `stream-json` flag — confirmed via live measurement; see Appendix C.

---

## Appendix C. Root Cause of Non-Working Streaming in ASD-Nexus (Confirmed via Live Measurement on 2026-11-06)

### Cause Matrix

| Harness | Current Execution Command (Adapter) | Measured Behavior | Verdict |
|---|---|---|---|
| Claude Code | Adapter `--output-format json` → promoted to `stream-json` by Core (`drivers.ts:1066-1073`, `claude-code` only) | Block-level streaming works normally | ✅ Working |
| Codex | `codex exec --json` (`codex.ts:25`) | Real-time JSONL events (demo completed) | ✅ Working |
| Antigravity | `agy -p --output-format json` (hardcoded in `antigravity.ts:57`) | Emits only a single final JSON object at exit. By contrast, `--output-format stream-json` streams `step_update`/`text_delta` token deltas (~25ms interval) flawlessly | ❌ Needs flag + parser fix |
| Cursor | `agent -p --output-format json` (hardcoded in `cursor.ts:71`) | Single final output only. Core's `stream-json` promotion was `claude-code`-only and skipped Cursor | ❌ Needs flag + parser fix |
| OpenCode | `run --format json` (`opencode.ts:38`) | **Per-completed-part granularity** — all 15 sentences arrive as a single `text` event (no token deltas). First event arrives only after ~28s MCP cold boot | ⚠️ Architectural limitation → requires `serve` + SSE |

### Key Facts

1. **The root cause lies in Core adapters/parsers, not in the GUI (`asd-gui`).** The GUI streaming pipeline (`createGuiDriverCommandRunner` → WS `driver_stream_event` → `useWsDriverStreamEvent`) works properly and propagates events whenever they arrive. The issue was that no streaming events were being emitted in the first place.
2. The `PLANNER_RESPONSE`/`TOOL_RESPONSE` schema expected by the Antigravity parser (`parseDriverStreamLine` lines 868–921) matches the disk `transcript.jsonl` format, not the empirical CLI `--output-format stream-json` schema (`{"event":"init"|"step_update"|"result", "text_delta":"..."}`). Changing the flag alone would not parse.
3. The comment in `EXTERNAL_SDK_REFERENCE.md` claiming "automatic `stream-json` activation for Claude/Cursor" contradicted the code (only `claude-code` was promoted).
4. OpenCode's `run --format json` emits events only upon part completion by CLI design → token-level real-time streaming is only possible via `opencode serve` + SSE `/api/event/subscribe` (`session.message.part.updated` deltas).

### Fix List (Localized Fixes Recommended — No Rewrite Needed)

1. `src/adapters/antigravity.ts`: `--output-format json` → `stream-json` (verified live)
2. `src/adapters/cursor.ts`: `--output-format json` → `stream-json` (+ evaluate `--stream-partial-output` option)
3. `src/core/drivers.ts`: Remove the `claude-code`-only `stream-json` promotion branch so adapters/builders use the proper format uniformly from the start
4. `src/core/drivers.ts::parseDriverStreamLine`: Add empirical Antigravity schema (`event: init|step_update|result`, `text_delta`) and Cursor `tool_call` (`started`/`completed`)
5. OpenCode: Accept block-level streaming in v1 + mitigate cold boot with `--attach` warm server → integrate `opencode serve` SSE for token streaming in v2
6. Align comments in `EXTERNAL_SDK_REFERENCE.md` with actual behavior

### Execution Status (2026-11-06)

- [x] 1-2. Antigravity & Cursor streaming flags — added `streaming` option to `buildHeadless/ResumeHarnessCommand` (`session-tracker`), branching to `stream-json` per harness. Kept non-streaming default (`json`) to protect batch paths such as subagents and debate.
- [x] 3. Removed Claude-only splice in `drivers.ts` — `runDriverTurn` now passes `streaming: useStreamJson` directly to the builder (unifying format selection inside the builder).
- [x] 4. Parser — added empirical Cursor schema (top-level thinking deltas, `tool_call.<family>ToolCall` started/completed, user prompt echo skipping) + Antigravity `stream-json` (`step_update` delta / `result` / `init`). Unit tests based on live-captured bytes passed (100% category accuracy).
- [x] 6. Updated comments in `EXTERNAL_SDK_REFERENCE.md`.
- [ ] 5. OpenCode `serve` + SSE — not started (separate task, App Plan M2).
- Verification: Core 355/356 (sole failure = pre-existing phantom test in `installer-sync`), `asd-gui` 14/14. Uncommitted.
