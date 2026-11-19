# Harness Integration Reference (`HARNESS_INTEGRATION_REFERENCE.md`)

**English** | [한국어](./HARNESS_INTEGRATION_REFERENCE_ko.md) | [📖 Back to README](./README.md)

> **Target Audience**: ASD Orchestrator CLI (TUI) / GUI App Development Team
> **Baseline**: ASD v2.5.0 · Verified as of 2026-11-07 (based on local empirical measurements — zero unverified assumptions; any unverified items are explicitly marked)
> **Product Definition**: Do not build a new harness. **Load the conversation list from existing harnesses, dispatch instructions from an input prompt, and render responses (Thinking, tool calls, and tool results) in real time.**

---

## 0. Repository Structure Recommendation — Keep New CLI (TUI) Separate from Core (`asd-multiagent`)

**Conclusion: Keep them separate.** A new TUI is a **consumer** of the Core SDK, on the exact same client tier as the GUI (`asd-gui`).

| Reason | Explanation |
|---|---|
| Preserve Boundary Principles | Core was finalized in v2.4.3 to retain only "CLI (`asd`) + core management + minimal SDK" ([`docs/CORE_GUI_BOUNDARY_AUDIT.md`](./docs/CORE_GUI_BOUNDARY_AUDIT.md)). Embedding a TUI inside Core would violate the boundary that was just established. |
| Zero-Dependency Invariant | Core must enforce `dependencies: {}` at the CI level. Adding TUI framework dependencies (such as Ink or React) breaks this invariant. |
| Release Independence | Harness adapters and the SDK evolve frequently, whereas client apps have a separate packaging (executable) release cycle. The decoupled model linked via an npm GitHub dependency (`agent-swarm-director`) is already proven in `asd-gui`. |

**Recommended Layout**: Co-locate TUI + GUI in a **single client app repository** (sharing a common client layer where 90% of session listing, streaming, and dispatch logic is identical). Either evolve `asd-gui` (reusing its server, authentication, and `StateWatcher`) or import only the Core SDK into a new app repository. **Adding an `asd chat`-style subcommand inside Core is prohibited** (dependency pollution + boundary regression). Note: Core's existing `asd` CLI itself is not a candidate for extraction — it is the core management CLI.

## 1. Documentation Checklist for the App Team

| Document | Purpose |
|---|---|
| **This Document** ([`HARNESS_INTEGRATION_REFERENCE.md`](./HARNESS_INTEGRATION_REFERENCE.md)) | Per-harness storage paths, formats, empirically measured event schemas, and pitfalls — the integration bible |
| [`EXTERNAL_SDK_REFERENCE.md`](./EXTERNAL_SDK_REFERENCE.md) | SDK function signatures, `core.db` schema, CLI subcommands, and `asd ui` HTTP API |
| [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) | Full Core architecture + file-by-file reference |
| [`docs/ORCHESTRATOR_APP_PLAN.md`](./docs/ORCHESTRATOR_APP_PLAN.md) | App architecture plan (Core server + TUI/GUI clients) and empirical harness streaming matrix (Appendix C) |
| [`docs/ACP_ROADMAP.md`](./docs/ACP_ROADMAP.md) | **Core ACP v1/v2 hybrid architecture, OpenCode `--async` callback flow, and future GUI (`runDriverTurn`) ACP integration checklist** |
| [`docs/CORE_GUI_BOUNDARY_AUDIT.md`](./docs/CORE_GUI_BOUNDARY_AUDIT.md) | Core–GUI boundary principles and violation rulings — criteria for what the app must never demand from Core |
| [`ROUTING_GUIDE.md`](./ROUTING_GUIDE.md) | Model routing configuration (for implementing harness and model selection UIs) |
| (When building on `asd-gui`) `src/shared/protocol.ts`, `GUI_ARCHITECTURE.md` in `asd-gui` | Existing REST/WS contracts and ADRs |

## 2. Common Principle — 3-Layer Integration Model

Treat every harness through the exact same three stages. **Because the ASD SDK already implements all three stages, the client app simply calls the SDK and renders the UI.**

| Stage | Capability | SDK Function (Module) |
|---|---|---|
| ① Session Discovery | Batch-scan sessions across all 5 harnesses executed in a project (including ASD promotion status) | `discoverProjectCliSessions(projectRoot, opts?)` (`core/session-tracker`) |
| ② Transcript Loading | Classify conversation history into 4 structured categories (`user` / `assistant` / `thinking` / `tool_use` / `tool_result`) | `readHarnessTranscript(query)` (`core/transcripts`) |
| ③ Turn Execution + Streaming | Send prompts, receive real-time events, and automatically capture/persist session IDs | `runDriverTurn(input)` + `parseDriverStreamLine` (`core/drivers`) |
| Auxiliary | Session/driver state, progress board, subagent logs, promotion/demotion | `openProjectDb`, `attachDriver`/`detachDriver`, `renderProgressBoard`, `scanSubagentLogs`, `promoteCliSessionToAsd`/`demoteAsdSession` |

**Normalized Event Contract** (`DriverStreamEvent`, the only event shape the UI needs to inspect):
`thinking` (collapsible real-time append) / `tool_use` (icon + name + args + spinner) / `tool_result` (collapsible, highlighted red when `isError` is true) / `text` (progressive Markdown) / `raw` (unparseable fallback line) + `harnessSessionId` and `toolId` metadata. Because the parser absorbs all harness differences, the UI layer must not contain harness-specific branching.

---

## 3. Per-Harness Integration Cards

### 3.1 Claude Code (`claude` v2.1.317) — Block Real-Time (Token Real-Time with Partial Flag)

| Item | Details |
|---|---|
| Session Storage | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` — **Official format instability warning** (never parse directly; always use `readHarnessTranscript`) |
| Streaming | `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages` |
| Events (Empirical) | `system/init` (`session_id`, `tools`, `model`) → `stream_event` (`content_block_delta`: `text_delta` / `thinking_delta` / `input_json_delta`) → `assistant` (completed blocks: `text` / `thinking` / `tool_use`) → `user` (carries `tool_result`) → `result` (final output + cost + `session_id`) |
| Send / Resume | `-p` + `--resume <uuid>` (compatible with streaming), `--continue`, `--fork-session` |
| Permissions / Approval | `--permission-mode`, `--permission-prompts host\|none`, SDK `canUseTool` (for v2 expansion) |
| Pitfalls | ① Pass long prompts via `stdin` ② Explicitly pass `--dangerously-skip-permissions` when required ③ Built-in defense against session JSONL schema drift (v2.5.0: `{text, parts}` object content, omitted `message` wrapper, lossless `toolUseResult` recovery) |

### 3.2 OpenCode (`opencode` v1.19.4) — Block Real-Time (Token Streaming via `serve` + SSE Only, P2 Task)

| Item | Details |
|---|---|
| Session Storage | `~/.local/share/opencode/opencode.db` (SQLite WAL, multi-GB) — `session_v2` / `session_message` tables. Check path via: `opencode debug paths db` |
| Streaming | `opencode run "<prompt>" --format json` — **Emits per completed part** (empirically verified that a 15-sentence reply arrives as a single `text` event). Events: `step_start` → `text` → `step_finish` (tokens, cost) |
| Token Real-Time (P2) | `opencode serve` + SSE `GET /api/event/subscribe` (`session.message.part.updated` deltas) — requires persistent server lifecycle management. Mitigate cold boot (~28s) using `run --attach http://localhost:4096` |
| Send / Resume | `run -s <ses_...>` / `-c` / `--fork`; `opencode export <id>` (JSON dump), `session list` |
| Permissions / Approval | `--auto` (auto-approve non-denied actions), permissions API (v2) |
| Pitfalls | ① Reads may fail while the DB is locked (retry required) ② Never full-scan the multi-GB DB — run session-ID-scoped queries only ③ Session IDs use the `ses_` prefix |

### 3.3 Codex CLI (`codex` v0.166.0) — Event Real-Time

| Item | Details |
|---|---|
| Session Storage | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` — **Older sessions use `.jsonl.zst` (zstd)** (v2.5.0: automatic transparent decompression via `node:zlib` / `zstd` CLI). Envelope: `{timestamp, ordinal, type: session_meta\|event_msg\|response_item\|turn_context, payload}` |
| Streaming | `codex exec "<prompt>" --json` |
| Events (Empirical) | `thread.started` (`thread_id`) → `turn.started` → `item.started\|completed` (`item.type`: `agent_message` / `reasoning` / `command_execution` (`aggregated_output`, `exit_code`) / `file_change` / `mcp_tool_call`) → `turn.completed` (`usage`) |
| Send / Resume | `codex exec resume <id> "<prompt>" --json` / `--last`, `codex fork` |
| Full Interactive Mode (v2) | `codex app-server` JSON-RPC — `initialize` handshake → `thread/start\|resume\|fork`, `turn/start\|steer\|interrupt`, approval RPC (`execCommandApproval`). Generate TypeScript bindings via `codex app-server generate-ts` |
| Permissions / Approval | `--sandbox read-only\|workspace-write`, `--dangerously-bypass-approvals-and-sandbox`, `app-server` runtime approvals |
| Pitfalls | ① Must close `stdin` in piped environments (otherwise hangs waiting on `"Reading additional input from stdin..."`) ② Official `@openai/codex-sdk` exists |

### 3.4 Antigravity (`agy` v1.5.1) — Token Real-Time (Highest Tier)

| Item | Details |
|---|---|
| Session Storage | `~/.gemini/antigravity-cli/conversations/<id>.db` (SQLite) + `brain/<id>/.system_generated/logs/transcript.jsonl` — falls back to `transcript_full.jsonl` when `truncated_fields` is present |
| Streaming | `agy -p "<prompt>" --output-format stream-json` |
| Events (Empirical) | `{"event":"init","conversation_id":...}` → `{"event":"step_update","step_update":{"state":"ACTIVE\|DONE","step_type":"agent_response","text_delta":"..."}}` **~25ms token deltas** → `{"event":"result","result":{"response":"<full text>","status":"SUCCESS"}}` |
| Send / Resume | `-p --conversation <id>`, `-c` (most recent), `--input-format stream-json` (persistent single-process multi-turn) |
| Permissions / Approval | `--dangerously-skip-permissions` or `--sandbox` |
| Pitfalls | ① `result.response` duplicates the accumulated delta text → requires UI deduplication (handled by ASD `onAssistantText`) ② Legacy `PLANNER_RESPONSE` parser branch is for `transcript.jsonl` on disk ③ App (IDE) artifacts are stored separately as Markdown (`~/.gemini/antigravity/brain/<id>/*.md`) |

### 3.5 Cursor CLI (`cursor-agent`) — Real-Time Thinking Tokens + Tool Lifecycle, Block Text

| Item | Details |
|---|---|
| Session Storage | `~/.cursor/chats/<workspace-md5>/<chat-uuid>/store.db` (SQLite, **undocumented proprietary blob format**) + `meta.json` → native store remains `unsupported`. However, starting in v2.5.0, ASD includes a Lossy JSONL Stream Fallback that automatically records headless execution streams to `~/.asd/transcripts/cursor/<sessionId>.jsonl` (preserving the `unsupported` return invariant when no fallback log exists) |
| Streaming | `cursor-agent -p "<prompt>" --force --output-format stream-json` |
| Events (Empirical) | `system/init` (`session_id`) → **`user` prompt echo (must be skipped)** → `{"type":"thinking","subtype":"delta","text":...}` top-level delta → `{"type":"tool_call","subtype":"started\|completed","call_id":...,"tool_call":{"<family>ToolCall":{"args":...,"result":{"success":...}\|{"error":{"errorMessage":...}}}}}` → `assistant` (block; presence of `model_call_id` distinguishes final flush) → `result` |
| Send / Resume | `--resume <chatId>`, `--continue`, `agent ls` (list), `create-chat` (pre-allocate empty chat ID) |
| Permissions / Approval | `--force` (`--yolo`), `--auto-review` (server-classified auto-approval) |
| Pitfalls | ① **`.ps1` wrapper on Windows** — spawn via `powershell -File` or `.cmd` shim from Node.js ② IDE and CLI session stores are separate ③ Avoid `--stream-partial-output` because it causes delta + buffer-flush duplication (distinguishable via `model_call_id`, not yet differentiated in parser) ④ `tool_result` payload path: `tool_call.<family>ToolCall.result.success` / `.error.errorMessage` |

---

## 4. ASD SDK → App Feature Mapping (What Not to Re-Implement)

| App Capability | Implementation | Build Custom in App? |
|---|---|---|
| Conversation List (5 Harnesses) | `discoverProjectCliSessions` | ❌ Call SDK |
| Session History View (4-Way) | `readHarnessTranscript` | ❌ Call SDK (built-in per-harness parsers) |
| Prompt Input → Execute + Live Render | `runDriverTurn({ onEvent, streaming: true })` | ❌ Call SDK — render UI only |
| Session Resume | `runDriverTurn` automatically resumes `harness_session_id` | ❌ |
| Progress Board (ASD Sessions) | `asd status --json` / `renderProgressBoard` | ❌ |
| Subagent Log Tailing | `scanSubagentLogs` + file tail | ❌ |
| Permission Approval UI (v2) | Per harness: SDK `canUseTool` / `app-server` RPC / permissions API | ⭕ UI only (SDK owns contract) |
| OpenCode Token Streaming (v2) | `opencode serve` + SSE integration | ⭕ New (P2 milestone) |
| Session Search / Memo / Grouping | `saveSessionMemo`, `listKnownProjects` | ❌ Call SDK |

**What the App Must Never Do**: Never assemble harness CLI flags directly in the app (owned by adapters/builders) — Never guess a harness from session ID format (`ses_` = OpenCode invariant is guaranteed by Core) — Never modify `.asd/` directly with raw file tools (use official SDK/CLI only) — Never request UI code inside Core (follow the `CORE_CHANGE_REQUEST` procedure, `GUI_ARCHITECTURE` ADR-01-3).

---

## 5. Pitfall Summary Matrix (Operational Checklist)

| Pitfall | Affected Harness | Mitigation |
|---|---|---|
| Hanging on piped `stdin` | Codex | Close `stdin` immediately after spawn |
| Cold boot ~28s | OpenCode | Use `run --attach` against a warm server, or keep `serve` resident |
| Legacy `.jsonl.zst` sessions | Codex | Transparent `zstd` decompression on load |
| DB lock contention (WAL) | OpenCode (2.2GB+), Cursor `store.db` | Retry with backoff + session-scoped queries only |
| Session JSONL schema drift | Claude | Always read via `readHarnessTranscript` + regression tests |
| `user` prompt echo in stream | Cursor | Skipped automatically by parser (since v2.4.3) |
| Full response duplicated in `result` | Antigravity | UI deduplication (built into ASD) |
| `.ps1` wrapper script | Cursor | Spawn via `powershell -File` or `.cmd` shim |
| Native transcript unavailable | Cursor | `unsupported` + lossy JSONL stream fallback (P4) |
| Hook bridge misattribution | OpenCode (OMO mirror) | Core enforces `ses_` attribution + self-healing (v2.4.3) |

---

## 6. Verification Checklist (Mandatory After Implementation)

1. **Event Parser**: Feed empirically captured bytes into `parseDriverStreamLine` and verify category classification (follow the pattern in ASD `driver-runner.test.ts` and `driver-hooks.test.ts`).
2. **Smoke Test**: Execute 1 turn via `runDriverTurn` on each harness — verify reception of `thinking` / `tool_use` / `tool_result` / `text` events and automatic persistence of `harnessSessionId`.
3. **Session Load Round-Trip**: Create 1 conversation on each harness and verify the `discoverProjectCliSessions` + `readHarnessTranscript` round-trip.
4. **Full Regression**: Run `node scripts/run-tests.mjs` (Core) — plus the app repository's own test suite.
