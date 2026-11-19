# ACP (Agent Client Protocol) Architecture & Future GUI Integration Roadmap (`docs/ACP_ROADMAP.md`)

**English** | [한국어](./ACP_ROADMAP_ko.md)

> **Baseline Version**: ASD v2.7.0  
> **Purpose**: Reference document for tracking the **ACP v1 client + v2 compatibility layer / hybrid Dispatch / OpenCode async completion callback** architecture completed in the Core repository (`asd-multiagent`), together with **carryover items scheduled for upcoming GUI (`ASD-Nexus` / `asd-gui`) and `runDriverTurn` enhancement phases**.

---

## 1. Summary of Key Design Decisions

| Decision Item | Adopted Approach | Rationale |
| :--- | :--- | :--- |
| **ACP Implementation Strategy** | **Pure Native Implementation (Zero-Dependency, keeping `dependencies: {}`)** | `@agentclientprotocol/sdk` depends on runtime `zod`, which breaks `tsc --noEmit` in zero-install `git pull` (`asd update`) environments and adds hook cold-start latency; therefore implemented directly in `src/core/acp-types.ts` + `src/core/acp-client.ts` |
| **Legacy CLI Dispatch Retention** | **Hybrid (`ACP Primary + Hardened Streaming CLI Fallback`)** | OpenCode, Antigravity, and Cursor use native ACP immediately, while Claude Code and Codex without external bridges installed (plus custom `CommandRunner` mock tests) run seamlessly via the hardened streaming CLI fallback |
| **OpenCode Main Session Freeze Resolution** | **`asd dispatch --async` + `asd-guard.js` (`client.session.prompt`) Auto-Callback** | Because OpenCode lacks background shell tasks, a detached background worker process (`--async`) returns within 100ms and the OpenCode plugin actively injects the completion report into the main session once finished |
| **GUI Driver (`runDriverTurn`) Scope** | **Kept As-Is (Managed as Carryover)** | `runDriverTurn` in `src/core/drivers.ts` was left unchanged during the initial Core overhaul to preserve backward compatibility with external GUI apps (`ASD-Nexus` / `asd-gui`) and is tracked via the checklist in Section 4 of this document |

---

## 2. Completed Core Implementation (v2.7.0)

### 2.1 Zero-Dependency ACP Client Engine (`src/core/acp-types.ts`, `src/core/acp-client.ts`)
- **Protocol Negotiation**: Built-in ACP v1 (`protocolVersion: 1`, `clientCapabilities: {}`) default handshake + ACP v2 draft compatibility adapter (immediate ACK followed by async `session/update` idle/turn_complete completion signals).
- **Session Lifecycle**: `session/new`, `session/load` (in-place resume within the same worktree upon transient idle stalls), `session/set_model` and `session/set_config_option` (model and reasoning effort configuration), `session/cancel` cooperative cancellation, and process tree cleanup.
- **Bidirectional Security Gate (`evaluateAcpPermissionRequest`)**: Immediately evaluates `session/request_permission` JSON-RPC requests sent by subagents during file edits or command execution against `policy.ts` (`evaluatePreToolUse`, `allowedFiles` boundaries, `.git/` / `.asd/` / `.env*` protected paths, and read-only enforcement for `scout` / `critic` roles) to return allow/deny responses.
- **Windows Execution Safety (`resolveAcpLaunchCommand`)**: Safely launches `.exe`, `.cmd`/`.bat` (including direct Node entrypoint extraction), and `.ps1` (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`) with `shell: false` to prevent stdio JSON-RPC stream corruption.

### 2.2 Per-Harness ACP Support Matrix & External Bridge Setup Guide

Running `asd doctor` and `asd sync` automatically checks the ACP readiness of each harness.

| Harness | Default Execution Path | ACP Command | Behavior When Missing & Setup Guidance |
| :--- | :--- | :--- | :--- |
| **OpenCode** | Native ACP | `opencode acp --pure` | Works via ACP immediately when the base CLI is installed |
| **Antigravity** | Native ACP | `agy acp --dangerously-skip-permissions` | Works via ACP immediately when the base CLI is installed |
| **Cursor CLI** | Native ACP | `cursor-agent acp` / `agent acp` | Works via ACP immediately, including automatic `.ps1` wrapper resolution |
| **Claude Code** | Official External Bridge (Optional) | `claude-agent-acp` | Automatically falls back to streaming CLI (`claude -p --output-format stream-json`) when not installed. To enable ACP: `npm i -g @agentclientprotocol/claude-agent-acp` |
| **Codex CLI** | Official External Bridge (Optional) | `codex-acp` | Automatically falls back to streaming CLI (`codex exec --json --full-auto`) when not installed. To enable ACP: `npm i -g @agentclientprotocol/codex-acp` |

> To install both external bridges at once:
> ```bash
> npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
> ```

### 2.3 Hardened Streaming CLI Fallback (`src/core/session-tracker.ts`, `src/core/spawner.ts`)
- **Output Buffering / Stall Elimination**: Enables real-time NDJSON streaming (`stream-json` / `--json`) across all harnesses during CLI fallback and defaults to `closeStdinOnSpawn: true` for headless execution.
- **Permission Prompt Hang Prevention**: Supplies `--dangerously-skip-permissions` for Antigravity/Claude, `--full-auto` for Codex, and `--pure` for OpenCode by default during non-interactive headless spawns, and automatically normalizes `model: "default"` on non-Cursor harnesses.
- **Sliding Timeout & Cause Separation**: Extends the overall timeout whenever real-time stream chunks arrive (`allowSlidingTimeout`) and distinguishes genuine unresponsive stalls (`timeoutReason: "idle"`) from hard upper-bound expirations (`"wall_clock"`). On a transient `"idle"` timeout, performs an immediate single in-place resume (`session/load` or CLI resume) in the same worktree using the captured `sessionId`.

### 2.4 OpenCode Async Dispatch & Automatic Completion Reporting (`--async` + `asd-guard.js`)
1. When the OpenCode main agent runs `asd dispatch --turn <N> --mode parallel_spawn --async`, ASD spawns a detached background worker, records `"running"` status in `.asd/sessions/<sessionId>/async-dispatch.json`, and **exits immediately within 100ms**.
2. Because the main session is not blocked, the user can continue chatting freely with the main agent or query `asd status` while tasks execute.
3. Once the background worker finishes subagent execution and the `verify` gate, it updates `async-dispatch.json` to `"done"` or `"failed"`.
4. The `~/.config/opencode/plugin/asd-guard.js` plugin detects this transition and, when the main session is idle (`session.idle`), invokes `client.session.prompt({ path: { id: sessionID }, body: { noReply: false, parts: [{ type: "text", text: report }] } })` exactly once (`notified: true`) so the main agent automatically proceeds to the next Wave or final summary.
5. For scripts and terminal environments requiring manual waiting, `asd wait [--session <id>] [--timeout <ms>]` and `--transport <auto|acp|cli>` flags are also provided.

---

## 3. Index of Key Related Files

- `src/core/acp-types.ts`: ACP v1 standard JSON-RPC message/event types and v2 compatibility type definitions
- `src/core/acp-client.ts`: `AcpStdioClient`, `probeAcpCapability`, `evaluateAcpPermissionRequest`, `executeAcpSubagentTurn`
- `src/mcp/server.ts`: `handleDispatch` hybrid execution, in-place `session/load` resume, and `--async` background worker detachment
- `src/core/debate.ts` / `src/core/subagent-control.ts`: Blind debate broker and subagent control hybrid execution plus `waitForAsyncDispatch`
- `src/adapters/opencode.ts`: `generateOpencodeGuardPlugin` (`client.session.prompt` async completion callback)
- `src/adapters/installer.ts` / `src/cli/index.ts`: `asd doctor`, `asd sync`, `asd dispatch --async --transport`, `asd wait`

---

## 4. Future Action Checklist — GUI (`ASD-Nexus` / `asd-gui`) & `runDriverTurn`

> [!IMPORTANT]
> The items below were intentionally separated and deferred so they can be executed in sequence alongside work on the external GUI repository (`ASD-Nexus` / `asd-gui`).

- [x] **G1. Introduce Persistent Multi-Turn ACP Session Options in `runDriverTurn` (`src/core/drivers.ts`)**
  - Introduced a persistent session pool (`driverSessionPool` / `DriverSessionPoolEntry`) in `src/core/drivers.ts` along with `transport?: "auto" | "acp" | "cli"` (default `"auto"`, or `"cli"` when `commandRunner` is specified) and `model?: string | null` options on `RunDriverTurnInput`.
  - Reuses `AcpStdioClient` under the same `(projectRoot, sessionId, driverId)` key, updates models via `AcpStdioClient.setSessionModel` when changed, and seamlessly falls back to CLI if Phase-A ACP connection fails in `"auto"` mode.
- [x] **G2. Unify Real-Time Streams Between `AcpNormalizedEvent` and `DriverStreamEvent`**
  - Maps `AcpNormalizedEvent` (`text`, `thinking`, `tool_use`, `tool_result`) to `DriverStreamEvent` (`type: "text" | "thinking" | "tool_use" | "tool_result"`, `harnessSessionId`, `timestamp`) via `mapAcpEventToDriverEvent` and forwards them to `onEvent` (`state` / `permission` events are excluded from `DriverStreamEvent`).
  - Does not invoke `onOutput` on the ACP path so raw JSON-RPC frames never interfere with the text stream.
- [x] **G3. Wire GUI Interactive Permission Approval Modal (`session/request_permission` Interactive Mode)**
  - Added async `onPermissionRequest?: (params: AcpRequestPermissionParams) => Promise<AcpRequestPermissionResult>` and `autoApprove?: boolean` to `AcpStdioClientOptions` / `setTurnHandlers` and `RunDriverTurnInput`.
  - Supports interactive permission mode via `probeAcpCapability(harness, env, { interactivePermissions })` (such as stripping `--dangerously-skip-permissions` for Antigravity when auto-approve is off) and pre-blocks out-of-workspace and protected paths (`.git/`, `.asd/`, `.env*`, etc.) via `checkInteractivePermissionSafety` before invoking the callback.
- [x] **G4. Direct Wiring for GUI In-Flight Immediate Cancel Button (`session/cancel`)**
  - Sends ACP `session/cancel` (`client.cancelSession`) to an in-flight turn via `AbortSignal` (`input.signal`) and `cancelDriverTurn(sessionId)` (cleaning up after a 1.5s grace period), and allows explicit termination of resident clients via `closeDriverSession(sessionId)` / `closeAllDriverSessions()` (as well as `closeDriverSessionByDriverId` on driver replacement or detach).
- [ ] **G5. ACP Status Badges and One-Click Bridge Setup Assistant in GUI Settings**
  - Display the `harnesses[id].acp` and `acpBridgeHints` fields returned by `runAsdDoctor()` in the GUI preferences panel, and show a guidance banner when the Claude Code / Codex bridges are not installed.
- [ ] **G6. Upgrade Support for Official ACP v2 Specification**
  - Once the upstream ACP v2 specification graduates from `draft` to final release, promote `src/core/acp-types.ts` and the default `preferredProtocolVersion` to v2 while preserving v1 negotiation fallback for older harnesses.
