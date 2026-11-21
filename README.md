# Agent Swarm Director (`ASD` v2.7.0)

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](./LICENSE)
[![Node.js: >=22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies: 0 (Zero-Dep)](https://img.shields.io/badge/dependencies-0%20(zero--dep)-red.svg)](./package.json)
[![GitHub Stars](https://img.shields.io/badge/stars-agent--swarm--director-yellow.svg?logo=github)](https://github.com/N3wbie123/agent-swarm-director/stargazers)

**English** | [한국어](./README_ko.md) | [🖥️ ASD-Nexus (GUI)](https://github.com/N3wbie123/ASD-Nexus) | [⚡ ACP Roadmap](./docs/ACP_ROADMAP.md) | [🧭 Routing Guide](./ROUTING_GUIDE.md) | [🏛️ Architecture](./PROJECT_STATUS.md) | [🔌 External SDK](./EXTERNAL_SDK_REFERENCE.md) | [📋 Patch Notes](./PATCH_NOTES.md)

> **Zero-dependency universal multi-agent orchestration harness and SDK across Claude Code, OpenCode, Codex CLI, Antigravity, and Cursor CLI.**

**Agent Swarm Director (`agent-swarm-director` / ASD v2.7.0)** coordinates five heterogeneous AI coding harnesses under a single deterministic control plane. Built purely on native Node.js (`>=22.13.0`) TypeScript execution and `node:sqlite` (WAL mode) with **zero external npm runtime dependencies (`dependencies: {}`)**, ASD combines **Agent Client Protocol (ACP) v1/v2 orchestration**, **Git worktree isolation**, **cross-model adversarial debate**, and a **1ms fail-closed security policy engine**.

> [!TIP]
> **🖥️ Official Desktop / Web GUI — [ASD-Nexus](https://github.com/N3wbie123/ASD-Nexus)**  
> Manage all 5 local harness sessions visually, inspect 4-way structured transcripts (*Thinking / Tool Use / Tool Result / Assistant*), stream live multi-harness turns, and promote or demote sessions with one click.

---

## Why ASD?

- **Zero Runtime Dependencies (`dependencies: {}`)** — Runs directly on Node.js `>=22.13.0` native TypeScript strip-types and `node:sqlite`. Zero `npm install` friction on `asd update`, zero supply-chain bloat, and sub-10ms hook startup.
- **Hybrid ACP-First Subagent Engine (v2.7.0)** — Spawns subagents over pure stdio JSON-RPC 2.0 **ACP v1** (with v2 draft compatibility), enforcing `allowedFiles` and protected-path rules live via bidirectional `session/request_permission` callbacks, auto-mapping `routing.jsonc` model names onto each harness's `session/new` catalog, resuming stalled turns in-place via `session/load`, and falling back seamlessly to hardened streaming CLIs when external bridges are absent.
- **First-Class OpenCode V2 Support & Generic Async Dispatch (`--async`)** — Automatically detects OpenCode V2 (`opencode v2.x`) vs frozen Legacy V1 (`1.x`), installs a zero-dependency V2 policy guard (`~/.config/opencode/plugins/asd-guard/index.js`), uses native `opencode acp` / `--auto` / `session_v2` transcripts, and leverages OpenCode V2's native background execution (while keeping harness-agnostic `--async` + `asd wait` available for any harness; see [OpenCode V1/V2 Support Policy](./docs/OPENCODE_V1_V2_MIGRATION_PLAN.md)).
- **3-Track Execution (`DIRECT` / `LIGHT` / `HEAVY`)** — Execute small 1–3 file sequential edits directly in the main session (`DIRECT`), delegate focused work to internal subagents with overlap checks (`LIGHT`), or fan out across multiple external harnesses in isolated Git worktrees with mutex-serialized `--no-ff` merges (`HEAVY`).
- **Blind Cross-Model Adversarial Debate (`asd debate`)** — Run parallel Round 1 critiques across distinct model families (`claude`, `gpt`, `gemini`, `glm`, `deepseek`) with code-slice/diff injection, followed by Round 2 binding arbitration.
- **Harness-Targeted Global Sync (`asd sync`)** — Installs harness-conditioned skills (injecting only target harness commands and dynamic `routing.jsonc` model tiers), 5 specialist personas (`planner`, `architect`, `worker`, `scout`, `critic`), actionable `PreToolUse` safety hooks, and missing external catalog MCP servers strictly into user home configs without polluting project repositories.
- **Modular CLI Orchestrator & Telemetry (`src/orchestrator/`)** — In-process CLI orchestration (`asd plan|dispatch|verify|debate`) with `asd plan schema`, 3-Strike verification escalation hints, capped test-output log pointers, best-effort token/cost/retry telemetry in SQLite/`asd status`/`.asd/summary.md`, and a lightweight 3-track trajectory eval suite (`npm run eval:trajectory`).
- **Full External GUI / TUI SDK** — Exposes session discovery (`discoverProjectCliSessions`), 4-way transcript parsing (`readHarnessTranscript`), live streaming turns (`runDriverTurn`), and CLI ↔ ASD session promotion/demotion (`promoteCliSessionToAsd` / `demoteAsdSession`).

---

## 5-Harness Support & ACP Matrix

`asd doctor` probes CLI availability, headless support, and ACP readiness in **~10ms**:

| Harness | Tag | CLI Binary | Primary Subagent Transport | Optional ACP Bridge Setup |
| :--- | :---: | :--- | :--- | :--- |
| **OpenCode** | `@oc` | `opencode` | **Native ACP** (`opencode acp` on V2; `--pure` on Legacy V1) | Built-in (ready out of the box) |
| **Antigravity** | `@ag` | `agy` | **Native ACP** (`agy acp`) | Built-in (ready out of the box) |
| **Cursor CLI** | `@cr` | `cursor-agent` / `agent` | **Native ACP** (`cursor-agent acp`) | Built-in (`.ps1` / `.cmd` auto-resolved) |
| **Claude Code** | `@cc` | `claude` | **ACP Bridge** → *Streaming CLI fallback* | `npm i -g @agentclientprotocol/claude-agent-acp` |
| **Codex CLI** | `@cx` | `codex` | **ACP Bridge** → *Streaming CLI fallback* | `npm i -g @agentclientprotocol/codex-acp` |

> Claude Code and Codex work out of the box via streaming CLI (`stream-json` / `--json --full-auto`); installing their official ACP bridges automatically upgrades them to bidirectional ACP transport.

---

## Quick Start

### Requirements
- **Node.js** `>=22.13.0`
- **Git** `>=2.30.0`

### 1. Install & Global Sync
```bash
# Sync skills, agents, safety hooks, and register 'asd' on global PATH
node --no-warnings src/cli/index.ts sync

# Verify environment, harness CLIs, ACP readiness, and PreToolUse security guard
asd doctor
```
*(Pass `--no-path` to `sync` if you prefer invoking `node --no-warnings <path>/src/cli/index.ts <cmd>` without modifying `PATH`.)*

### 2. Typical CLI Workflow
```bash
asd status                                                # Live TODO progress board & active session state
asd plan get                                              # Inspect current .asd/PLAN.md & SQLite tasks
asd dispatch --turn 1 --mode parallel_spawn               # Execute Turn 1 across routed harnesses (ACP-first)
asd dispatch --turn 1 --mode parallel_spawn --async       # Optional detached background wave (required only in Legacy OpenCode V1)
asd wait --timeout 600000                                 # Wait for a detached '--async' wave if needed
asd verify --task T1.1 --summary "Add ACP model mapper"   # Boundary + secret + test gate & clean commit
asd debate --topic "Storage" --proposal "Use SQLite WAL"  # Cross-model blind critique & binding verdict
asd handoff                                               # Generate secret-redacted handoff.md
```

<details>
<summary><strong>📦 Upgrading from Legacy ASD ≤ v2.3.2? (<code>asd migrate</code>)</strong></summary>

Starting in **ASD v2.3.3+**, per-project hash databases (`~/.asd/state/<hash>/core.db`) were unified into a single shared WAL database (`~/.asd/state/core.db`). Migrate legacy sessions, tasks, and debates safely with automatic backup:

```bash
asd migrate
asd migrate --clean-legacy   # Optional: delete old per-hash core.db files after import
```
</details>

---

## In-Chat Slash Skills (`/asd*`, `/handoff`)

After running `asd sync`, use these commands directly inside **Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**, or **Cursor CLI**:

| Skill | Purpose | Workflow Summary |
| :--- | :--- | :--- |
| **`/asd <goal>`** | **End-to-End Autonomous Execution** | Explores codebase via `asd-scout`, presents a pre-flight plan & `LIGHT`/`HEAVY` recommendation, writes `.asd/PLAN.md`, executes waves, verifies gates, and outputs `.asd/summary.md`. |
| **`/asd-plan <goal>`** | **Plan Only (Zero Code Edits)** | Read-only discovery, clarifying questions, and `.asd/PLAN.md` + SQLite task generation with mode recommendation. |
| **`/asd-run`** | **Execute / Resume `.asd/PLAN.md`** | Syncs manual edits from `.asd/PLAN.md` (`asd plan sync_from_md`), confirms `LIGHT` vs `HEAVY`, and runs remaining turns. |
| **`/asd-debate <topic>`** | **Adversarial Design Debate** | Runs blind multi-model Round 1 critiques + Round 2 arbitration (`APPROVE` / `MINOR_AMEND` / `REJECT`) and binds constraints into tasks. |
| **`/asd-debug <issue>`** | **Hypothesis-Driven Debugging** | Reproduces the bug with a deterministic test first, diagnoses root cause, applies minimal fix, and verifies via `asd verify`. |
| **`/handoff`** (`/asd-handoff`) | **Cross-Harness Session Handoff** | Combines SQLite progress, git state, routing summary, and conversation context into `handoff.md` for seamless continuation on any harness. |

### `DIRECT` vs `LIGHT` vs `HEAVY` Execution Modes

| Mode | Subagent Delegation | Workspace & Verification Behavior | Best For |
| :--- | :--- | :--- | :--- |
| **`DIRECT`** *(Main Session)* | Main session executes edits directly (`claim_only`), optionally calling `asd-scout` for broad read-only search. Zero subagent spawn overhead. | In-place edits gated by `asd verify` with 3-Strike escalation hints and clean task-ID-free commits. | 1–3 file sequential changes, quick fixes, tight context continuity. |
| **`LIGHT`** *(Single-Harness)* | Native internal `asd-<role>` subagents inside your current harness (`claim_only`). Same-turn multiple workers run sequentially or require disjoint `targetFiles`. Zero external CLI spawning. | In-place edits; preserves working-tree files on test failure for quick fixes, rolls back scoped files on boundary/secret violations, and writes clean commits. | Role-specialized single-harness tasks, bug fixes, preserving multi-harness quotas. |
| **`HEAVY`** *(Multi-Harness)* | Spawns external harnesses concurrently via ACP / streaming CLI per `routing.jsonc` (`parallel_spawn`; OpenCode V2 uses native background tasks, optional `--async` available). | Dedicated Git worktree per task (`.asd/wt/<turn>-<taskId>`) with `node_modules` junction + cross-process mutex `--no-ff` merge. | Disjoint parallel modules, high-risk refactors, cross-model blind review. |

<details>
<summary><strong>🕰️ Legacy OpenCode V1 Support Policy (Frozen Compatibility Mode)</strong></summary>

OpenCode **V2 (`2.x`)** is the primary supported target (`plugins/asd-guard/index.js`, `opencode acp`, native background tasks). OpenCode **V1 (`1.x`)** is frozen in `src/adapters/opencode-v1.ts` (security/critical fixes only): `asd sync` installs `plugin/asd-guard.js`, renders Legacy V1 `--async` skill instructions, and `asd doctor` flags version-vs-plugin drift. The V1 path will be removed upon official OpenCode V1 EOL or when V1 usage falls to single digits (announced ≥1 minor release in advance). See **[OpenCode V1/V2 Migration & Support Policy](./docs/OPENCODE_V1_V2_MIGRATION_PLAN.md)**.
</details>

---

## CLI Command Reference

> When installed with `--no-path`, replace `asd` with `node --no-warnings src/cli/index.ts`.

| Command | Description |
| :--- | :--- |
| `asd sync [--force] [--refresh-models] [--no-model-probe] [--no-path]` | Sync global skills, 5 core agents, hooks, MCP catalog, and `PATH` shims across all 5 harnesses. |
| `asd update` | Pull latest ASD release via Git and run a fresh global `asd sync`. |
| `asd doctor [--json]` | ~10ms zero-token diagnostic: Node `>=22.13.0`, SQLite WAL, Git repo, harness binaries, ACP readiness, and `PreToolUse` probe. |
| `asd plan [create\|get\|update\|sync_from_md\|schema] [--file <path>] [--track <DIRECT\|LIGHT\|HEAVY>]` | Create, query, update, reverse-sync `.asd/PLAN.md` with `~/.asd/state/core.db`, or inspect the canonical plan JSON schema. |
| `asd dispatch [--turn <n>] [--mode <m>] [--async] [--transport <auto\|acp\|cli>]` | Dispatch wave tasks (`parallel_spawn` or `claim_only`); `--async` runs non-blocking in a detached worker. |
| `asd wait [--session <id>] [--timeout <ms>] [--json]` | Block until an active `asd dispatch --async` wave completes and print results. |
| `asd verify --task <id> [--summary <text>] [--cmd <cmd>] [--file <path>]` | Enforce `allowedFiles` boundaries, secret scan, and test command (`300s` default timeout), then commit or merge cleanly. |
| `asd debate --topic <t> --proposal <p> [--harnesses <csv>] [--diff]` | Run parallel blind cross-model critiques and Round 2 arbitration. |
| `asd status [--json]` | Render live TODO `progressBoard`, active async job state, and auto-stash warnings. |
| `asd logs [taskId] [--json]` | Inspect the latest (or task-specific) redacted subagent prompt & output log. |
| `asd resume [--session <id>] [--print\|-p] [--json]` | Demote active ASD session and launch (or print) the native interactive harness CLI resume command. |
| `asd handoff [-o <path>] [--print\|-p] [--json]` | Generate a secret-redacted cross-harness `handoff.md` snapshot. |
| `asd clean [--pop] [--all] [--purge-orphans]` | Prune leftover `.asd/wt/*` worktrees/branches, restore auto-stashed work (`--pop`), or purge orphaned DB sessions. |
| `asd migrate [--clean-legacy] [--json]` | Import legacy per-project/local `core.db` files into `~/.asd/state/core.db`. |
| `asd ui [-p <port>]` | Launch the lightweight feature-frozen local status dashboard (`http://127.0.0.1:3847`; new UI development lives in **ASD-Nexus**). |
| `asd uninstall [--home <dir>]` | Surgically remove all ASD-managed global files, hooks, shims, and `_asdManaged` config entries while restoring user configs 100%. |

---

## Documentation

- ⚡ **[ACP Architecture & GUI Roadmap (`docs/ACP_ROADMAP.md`)](./docs/ACP_ROADMAP.md)** — Pure ACP v1/v2 design, OpenCode V2 native ACP & Legacy V1 `--async` callback flow, bridge setup, and GUI (`runDriverTurn`) checklist.
- 🔄 **[OpenCode V1/V2 Support Policy & Migration Plan (`docs/OPENCODE_V1_V2_MIGRATION_PLAN.md`)](./docs/OPENCODE_V1_V2_MIGRATION_PLAN.md)** — V2 first-class architecture, frozen V1 compatibility scope, and V1 EOL/single-digit removal trigger.
- 🧭 **[Model Routing Guide (`ROUTING_GUIDE.md`)](./ROUTING_GUIDE.md)** — Configuring `lightSubagents`, `agents`, `categories`, fallbacks, and `thinkingEffort` in `~/.asd/routing.jsonc`.
- 🏛️ **[Architecture & Code Reference (`PROJECT_STATUS.md`)](./PROJECT_STATUS.md)** — Repository layout, SQLite SSOT schema, and module-by-module reference.
- 🔌 **[External SDK & DB Reference (`EXTERNAL_SDK_REFERENCE.md`)](./EXTERNAL_SDK_REFERENCE.md)** — Node.js SDK contracts and database schema for **ASD-Nexus** and external tools.
- 🔗 **[Harness Integration Reference (`HARNESS_INTEGRATION_REFERENCE.md`)](./HARNESS_INTEGRATION_REFERENCE.md)** — Empirical stream formats, session storage paths, and caveats across all 5 harnesses.
- 🤖 **[AI Workflow Prompt (`AI_WORKFLOW_PROMPT.md`)](./AI_WORKFLOW_PROMPT.md)** — Ready-to-use onboarding prompt for AI coding agents.
- 📋 **[Patch Notes (EN)](./PATCH_NOTES.md)** · **[패치 노트 (KO)](./PATCH_NOTES_ko.md)** — Full version history through `v2.7.0`.

---

## Testing & Trajectory Eval

```bash
npm run typecheck
npm test
npm run eval:trajectory      # Deterministic offline 3-track benchmark (DIRECT vs LIGHT vs HEAVY)
```

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
