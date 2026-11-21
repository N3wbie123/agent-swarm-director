# OpenCode V1/V2 Support Strategy and V1 Freeze Migration Plan (OPENCODE_V1_V2_MIGRATION_PLAN.md)

**English** | [한국어](./OPENCODE_V1_V2_MIGRATION_PLAN_ko.md)

> **Date**: 2026-11-21
> **Baseline commit**: `2dceeae` (main)
> **Purpose**: Define ASD's support policy for the coexisting OpenCode V1/V2 releases, inventory V1-only code, and lay out the V2 migration and V1 freeze/removal plan.
> **Status**: In progress (Session `asd-20261121-212400-ocv2`, amended via Debate `D-mwqdzqsd-NGID`). Local OpenCode upgraded from V1 `1.19.4` to V2 `opencode v2.3.2` (`@opencode/cli@2.3.2`); external verified backup stored at `~/.asd/backups/opencode-v1-pre-upgrade-20261121-213700/` (20 top-level config files + V1 `opencode.exe` SHA-256 matched). All existing `~/.config/opencode/` user configs loaded cleanly via V2 auto-translation with zero deletions or edits required. **Transition-window notice**: Local OpenCode V2 currently runs without ASD PreToolUse/Stop policy guards until Phase 2 (`T4.1` / `T6.1`) lands.

---

## 1. Decision Summary

| Item | Decision |
|---|---|
| V2 | First-class support. The only target for new features and hook/plugin development |
| V1 | Frozen compatibility mode. No new features. Only security/critical fixes and compatibility fixes caused by shared-code changes |
| Prerequisite | `opencode --version` based version detection + capability profile |
| Removal trigger | Official V1 EOL or V1 usage falling to single digits, whichever comes first. Announce in README in advance |
| Prohibited | Do not delete commit `8468491` wholesale. It also contains ACP hybrid Dispatch, in-place idle resume, and the generic `--async` |

**Core judgment**: V1-only code is concentrated in `src/adapters/opencode.ts` plus a few fields, flags, and docs, so isolation is cheap. V2's plugin API is a breaking change, so **a V2 hook system must be built regardless**. Therefore, "V2-first development + frozen V1 support" is the balance point between maintenance cost and user churn risk.

---

## 2. Verified Facts

### 2.1 External Facts (OpenCode official/public sources)

| Item | Status | Note |
|---|---|---|
| V1 auto-update | Stopped since v1.19.0 | Updates must be run manually |
| V1 to V2 upgrade | Officially offered since v1.19.6 | V2 downloads in the background and installs when the user chooses |
| V2 mainline | 2.x changelog | 2.0 announced in October 2026; 2.3.x as of November 2026 |
| V2 background tasks | Subagents background by default since v2.3.0; background shell commands | Natively resolves the main-session freeze |
| V2 breaking changes | Plugin API, server API, terminal config file (`cli.json`) | V1 plugins do not load in V2 |
| V1/V2 installation | Share the same `opencode` command and config paths; not installed side by side by default | Runtime version detection is mandatory |
| V1 EOL date | Not officially confirmed | Treat as an **assumption** in this plan |
| V1 1.x patches | Apparently still provided | Based on external reporting; not officially guaranteed |

### 2.2 Codebase Facts

| Item | Status | Evidence |
|---|---|---|
| OpenCode version detection | Absent | No `opencode --version` probe anywhere in the codebase |
| V1/V2 distinction | Absent | Single harness ID `"opencode"` (`src/core/types.ts:78`) |
| V2 plugin API implementation | Absent | Only the V1 plugin exists (`src/adapters/opencode.ts:90-366`) |
| V2 policy guard | **Gap** | The V1 plugin does not load in V2, so there is no PreToolUse/Stop guard |
| Generic async Dispatch | Present | Harness-agnostic path (`src/orchestrator/dispatch-handler.ts:823`) |
| V1-only completion callback | Present | `asd-guard.js` + `openCodeSessionId` plumbing |

---

## 3. Code Inventory

### 3.1 V1-Only (Isolate, Freeze, Eventually Remove)

#### A. The entire `asd-guard.js` V1 plugin

It depends on the V1 plugin API (`tool.execute.before`, `session.idle`, `client.session.prompt`) and therefore does not work in V2. It handles **both** policy hooks and the async completion callback, so removing it before V2 replacement hooks exist would leave a policy-guard gap.

| Component | Location | Description |
|---|---|---|
| Plugin generator | `src/adapters/opencode.ts:90-366` | Generates the V1 plugin source string |
| Policy hook wiring | `src/adapters/opencode.ts:309-361` | `tool.execute.before` to `asd hook pre-tool-use`, `session.idle` to `asd hook stop`, `session.status` busy/idle tracking |
| Async completion watcher/injector | `src/adapters/opencode.ts:195-292` | Polls `.asd/sessions/*/async-dispatch.json` and injects the report into the main session via `client.session.prompt` |
| Bun runtime workaround | `src/adapters/opencode.ts:84-116` | Bakes the Node path to avoid `process.execPath` pointing at `opencode.exe` |
| Install/remove/hash/doctor text | `src/adapters/installer.ts:1195-1197`, `:2078`, `:793`, `:2514` | Manages `~/.config/opencode/plugin/asd-guard.js` |

#### B. V1 completion-callback session ID plumbing

| Item | Location |
|---|---|
| `AsyncDispatchJobMeta.openCodeSessionId`, `notified`, `notifyAttempts` | `src/core/types.ts:352-353` |
| `AsdDispatchInput.openCodeSessionId` | `src/core/types.ts:381` |
| `--opencode-session` parsing/passing | `src/cli/index.ts:166`, `:345-349`, `:2076` |
| Session ID recorded in async job | `src/orchestrator/dispatch-handler.ts:845` |

#### C. V1-only skill instructions

| Item | Location |
|---|---|
| "OpenCode Non-Blocking Rule": always `--async` + `asd-guard.js` auto-notify | `src/skills/asd-run/SKILL.md:51` |
| "MUST pass `--async`" | `src/skills/asd/SKILL.md:57` |
| Installer assertion | `tests/installer-sync.test.ts:1584` |

#### D. V1-only documentation

| Item | Location |
|---|---|
| README OpenCode async description, command examples, HEAVY table | `README.md:24`, `:70-71`, `:109`, `:123-124` |
| Same items in the Korean README | `README_ko.md`, same lines |
| ACP roadmap freeze-resolution description | `docs/ACP_ROADMAP.md:16`, `:51-55` |
| Same items in the Korean ACP roadmap | `docs/ACP_ROADMAP_ko.md`, same lines |

### 3.2 Created Because of V1 but Generic (Keep)

| Item | Location | Note |
|---|---|---|
| `--async` detached worker, `async-dispatch.json` | `src/orchestrator/dispatch-handler.ts:823-950` | No harness gate; usable by any harness |
| Job persistence/polling helpers | `src/core/subagent-control.ts:800-880` | Used by `asd wait` |
| `asd wait`, `asd status` asyncJob display | `src/cli/index.ts:272`, `:1311`, `:1427`, `:2085-2100` | Generic CLI surface |
| Tests | `tests/cli-commands.test.ts:355`, `tests/orchestrator.test.ts:1786` | Generic behavior coverage |

**Principle**: Keep the engine generic; limit V1-specific code to the completion-callback layer.

### 3.3 Shared OpenCode Adapter Surface (Phase 0 Verified on `opencode v2.3.2`)

| # | Feature | Location | V2 status |
|---|---|---|---|
| 1 | Headless run: `opencode run --format json [--pure] [--model]` | `src/core/session-tracker.ts:179-183`, `src/core/spawner.ts:366,425` | **Replacement required**: `--format json`, `--model` supported; `--pure` removed in V2 (use `--auto` on V2) |
| 2 | Headless resume: `opencode run --session <sid>` | `src/core/session-tracker.ts:250-261` | **Supported**: `opencode run --session <sid>` (`-s`) preserved |
| 3 | Interactive resume: `opencode --session <sid>` | `src/core/session-tracker.ts:335-339` | **Supported**: `opencode --session <sid>` (`-s`) preserved |
| 4 | ACP: `opencode acp --pure` | `src/core/acp-client.ts:249-258` | **Replacement required**: `--pure` fails (exit 1: `Unrecognized flag: --pure`); `opencode acp` works natively (`protocolVersion: 1`, `loadSession: true`) |
| 5 | Model discovery: `opencode models` | `src/core/models.ts:518-533` | **Supported**: outputs `provider/model` lines including custom `opencode.jsonc` providers |
| 6 | Config scan: `opencode.json/jsonc`, `agent/*.md` | `src/core/models.ts:367-441`, `src/adapters/installer.ts:1199-1258` | **Supported (with caveats)**: V2 reads `opencode.json(c)` and auto-normalizes V1 `mcp`/`plugin`/`agent`/`provider`; ignores `mcpServers` (uses `mcp.servers`), strips `_asdVersion`, moves TUI prefs to `cli.json` |
| 7 | `oh-my-openagent.json` detection/cleanup | `src/adapters/installer.ts:1261-1271`, `:2094-2119` | **Supported (bug fix needed)**: layout unchanged; fix `installer.ts:2104` to use `parseJsonc` on uninstall |
| 8 | Session DB/transcripts: `opencode.db`, storage JSON fallback | `src/core/session-tracker.ts:1402-1406`, `src/core/transcripts.ts:1071-1169`, `:1459-1516` | **Replacement required**: `opencode.db` adds V2 tables (`session_v2`, `session_message` with inline `data.content[]`, `session_part`) alongside legacy V1 tables (`session`, `message`, `part`) |
| 9 | `ses_` session ID attribution correction | `src/core/session-tracker.ts:1516-1526` | **Supported**: V2 `session_v2.id` retains `ses_*` format |
| 10 | daemon-sse: `opencode serve` SSE parser + `/session/:id/abort` | `src/core/spawner.ts:829-846`, `src/adapters/opencode.ts:16-58`, `src/core/drivers.ts:611-650`, `src/core/types.ts:517` | **Replacement required**: V2 OpenAPI (`/openapi.json`, 142 routes) moved SSE to `/api/event` and abort to `/api/session/{sessionID}/interrupt` |
| 11 | Model defaults/format | `src/core/router.ts:224,667,710`, `src/core/drivers.ts:517-518`, `src/core/debate.ts:918`, `src/core/models.ts:799-800` | **Supported**: `provider/model` (optional `#variant`) preserved |
| 12 | Policy tool names: `write/edit/patch/multiedit`, `bash` | `src/core/policy.ts:74-78` | **Replacement required**: V2 `ctx.tool.list()` confirmed write tools `write`/`edit`/`patch` and shell tool renamed `bash` → `shell` |
| 13 | Install targets: `command/`, `agent/`, `AGENTS.md`, `opencode.json` | `src/adapters/installer.ts:1165-1191`, `src/adapters/opencode.ts:403-418` | **Replacement required (plugin dir)**: `command/`, `agent/`, `AGENTS.md`, `opencode.json(c)` remain compatible; V2 plugins auto-load from `plugins/<name>/index.js` without editing `opencode.json(c)` and ignore single-file `plugin/asd-guard.js` |
| 14 | Agent frontmatter: `mode: subagent`, read-only `tools:` | `src/adapters/installer/agent-renderer.ts:162-170` | **Supported**: `opencode debug agents` confirmed V2 auto-translates read-only `tools: { write/edit/patch: false }` into `{ action: "edit", resource: "*", effect: "deny" }` |
| 15 | ACP readiness probe | `src/adapters/installer.ts:2438-2458` | **Replacement required**: probe must use `["acp"]` on V2 and `["acp", "--pure"]` on V1 |
| 16 | Dashboard model picker/labels | `src/cli/dashboard.ts` | **Supported**: shared UI consumes `provider/model` catalog unchanged |

#### Phase 0 Verified V2 Plugin & Runtime Contract (`opencode v2.3.2`)
- **Version string format**: V1 outputs bare semver (`1.19.4`); V2 outputs `opencode v2.3.2` (exit code `0`).
- **Zero-dependency V2 plugin**: `@opencode/plugin@2.3.2` `Plugin.define(p)` is an identity function; a plain ESM export `export default { id: "asd-policy-guard", async setup(ctx) { ... } }` placed at `~/.config/opencode/plugins/asd-guard/index.js` auto-loads in V2 with zero npm runtime dependencies (`package.json` `dependencies: {}` preserved) and without editing `opencode.json(c)`.
- **Bun `process.execPath` pitfall confirmed in V2**: Inside V2 plugins on Windows, `process.execPath` still points to `...\@opencode\cli\bin\opencode.exe`; baking the Node.js binary path at sync time remains mandatory.
- **V2 Hook API**:
  - PreToolUse: `await ctx.tool.hook("execute.before", (event) => { ... throw new Error(reason); })` (`event = { tool, sessionID, agent, messageID, id, input }`; root dir via `ctx.location?.directory || process.cwd()`).
  - Stop: `ctx.event.subscribe({ signal: controller.signal })` observing `event.type === "session.idle"` with cleanup `() => controller.abort()`.
  - Stale V1 `plugin/asd-guard.js`: ignored without crashing by V2, but should be removed on V2 sync to eliminate `asd doctor` drift.
- **Post-T2.1 Re-Plan Gate**: 5 core modules require V2 updates (`acp-client.ts`, `policy.ts`, `drivers.ts`, `session-tracker.ts`, `transcripts.ts`); split Turn 4 core work into `T4.2` (`acp-client`, `policy`, `drivers`) and `T4.3` (`session-tracker`, `transcripts`).

### 3.4 Missing Entirely (New Work for V2)

1. OpenCode version detection (`opencode --version` probe)
2. V2 plugin API implementation (policy hooks + completion notification)
3. V2 config differences (`cli.json`, `commands`, V2 agent frontmatter)
4. V2 server API/ACP compatibility verification and adapter fixes if needed
5. Defining how ASD Dispatch relates to V2 native background tasks

---

## 4. Support Policy

### 4.1 Support Level by Version

| Area | V2 | V1 |
|---|---|---|
| New features | Yes | None |
| Bug fixes | Yes | Security/critical only |
| Compatibility fixes | Yes | Only breakage caused by shared-code changes |
| Hooks/plugins | New implementation with the V2 API | Existing `asd-guard.js` frozen |
| Documentation | Current | Marked "Legacy" |
| Tests | Full matrix | Smoke tests only |

### 4.2 Removal Trigger

Remove the V1 path when the first of the following occurs.

1. Official OpenCode V1 EOL announcement
2. V1 share (surrounding users/telemetry/issue reports) falls to single digits

Announce in the README and this document at least one minor release before removal.

### 4.3 Do Not

- Revert/delete commit `8468491` wholesale: ACP hybrid Dispatch, in-place idle resume, and generic `--async` would disappear with it.
- Remove the V1 plugin before V2 policy hooks exist: this creates a V2 policy-guard gap.
- Treat `--async`/`asd wait` as "OpenCode-only" and delete them: the CLI, tests, and docs depend on this generic surface.

---

## 5. Phased Migration Plan

### Phase 0: Verification Spikes (read-only)

Goal: Confirm the "needs verification" items in 3.3 against real V1/V2 installations and finalize the support matrix.

| Task | What to check |
|---|---|
| Version probe | `opencode --version` output format (V1/V2), exit code |
| CLI surface | `run --format json`, `--pure`, `--model`, `--session`, `opencode models` |
| ACP surface | Whether `opencode acp --pure` works; V2 server API differences |
| Config surface | `opencode.json/jsonc`, `command/` vs `commands/`, agent frontmatter |
| DB surface | `opencode.db` schema, storage JSON fallback, `ses_` IDs |
| Policy surface | V2 tool names (`write/edit/patch/bash`, etc.) and event names |
| Plugin surface | V2 plugin API events/client methods |

**Acceptance**: Every "needs verification" row in 3.3 is updated to `supported / unsupported / replacement required`.

### Phase 1: Version Detection + Capability Profile

Goal: Establish the foundation for branching V1/V2 behavior while keeping the single `"opencode"` harness ID.

- Add `detectOpenCodeVersion()` (parse `opencode --version`; fall back to `unknown`)
- Define a capability profile: `{ version, pluginApi: "v1" | "v2" | "unknown", supportsAcp, supportsModelsCmd, ... }`
- Installer decides whether to install the V1 plugin based on the profile
- Keep the profile behind the adapter boundary; shared code references only the interface

**Acceptance**: V1/V2 detection tests, no behavior change for other harnesses, full test suite passes.

### Phase 2: V2 Hook/Plugin Adapter

Goal: Restore the policy guard and completion notification on V2.

- Implement policy hooks (PreToolUse/Stop equivalents) with the V2 plugin API
- Decide whether ASD `--async` is needed when V2 native background tasks are used
  - If V2 backgrounds shell commands and notifies on completion, the ASD detached worker + guard callback may be optional on V2
  - Specify behavior when `asd dispatch` is called blocking (timeout, background transition)
- Design the completion notification path against the V2 API (confirm the counterpart to V1 `client.session.prompt`)

**Acceptance**: Policy-guard parity tests and async completion notification tests pass on V2.

### Phase 3: V1 Isolation and Freeze

Goal: Confine V1-only code to one module and remove direct references from shared code.

- V1-only module, e.g. `src/adapters/opencode-v1/` or a single `opencode-v1.ts`
  - `asd-guard.js` generator, V1 session ID plumbing, V1 skill text
- Shared code references only the capability interface (no direct imports of V1 symbols)
- `openCodeSessionId`/`--opencode-session`/`notified` fields are used only under the V1 profile
- Keep generic `--async`/`asd wait`
- Freeze rule: no changes to the V1 module except security/critical fixes

**Acceptance**: `grep` finds no V1-only symbols outside the V1 module and tests. V1 smoke tests and the V2 official suite pass.

### Phase 4: Documentation and Skills

Goal: Separate V1/V2 guidance and publish the support policy.

- Add V1/V2 conditional blocks to the skill renderer
  - V2: guidance based on native background tasks
  - V1: existing `--async` + `asd-guard.js` guidance (marked Legacy)
- Move V1 descriptions in README/README_ko/ACP_ROADMAP into a Legacy section
- Link the support policy (section 4) and removal trigger from the README

**Acceptance**: V2 users are not shown V1-only instructions. Doc links/language switchers work.

### Phase 5: V1 Removal (when the EOL trigger is reached)

- Remove the V1 module, flags, fields, docs, and tests
- Clean up installer logic for V1 plugin install/removal
- Bump at least a minor version (breaking change)
- Announce the removal in `PATCH_NOTES.md`

**Acceptance**: The V2-only test matrix passes. No V1 symbols/docs remain.

---

## 6. Test and CI Policy

| Area | V2 | V1 |
|---|---|---|
| Unit/integration | Full matrix | Smoke only |
| Policy guard | Required | Frozen (keep existing tests) |
| Async completion notification | V2 method required | Keep existing method |
| Version detection | Required | Required |
| Removal point | - | Delete V1 tests together |

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| V2 policy-guard gap | `.asd/` protection and tool blocking do not work on V2 | Run Phase 2 before Phase 3 |
| V2 plugin API instability | Hook rework | Verify in Phase 0; pin versions + feature detection |
| Shared binary/config paths | Wrong version branching | Runtime version probe instead of path assumptions |
| Wrong V1 EOL assumption | Premature removal drives users away | Keep the V1 module until the trigger is reached |
| Over-deletion of `8468491` | Loss of ACP hybrid/generic async | Isolate only the V1 callback layer; keep the generic engine |
| Skill/doc drift | V1 instructions exposed on V2 | Renderer conditionals + doc tests |
| V2 server API changes | daemon-sse/abort stops working | Phase 0 verification; CLI streaming fallback on failure |

---

## 8. Finalized Decisions (Confirmed & Amended via Debate `D-mwqdzqsd-NGID`)

1. **V1 removal trigger**: Rely on official V1 EOL or V1 usage falling to single digits (whichever comes first), announced ≥1 minor release in advance (no fixed calendar cutoff).
2. **V2 `--async` & completion notification**: Keep the generic `--async` / `asd wait` engine intact; guide V2 users to V2 native background tasks by default, prioritize PreToolUse/Stop policy guards in the V2 plugin, and connect completion notification only if Phase 0 confirms a compatible V2 client API.
3. **V1 freeze policy hooks**: Keep `asd-guard.js` policy hooks working during the V1 freeze (security/critical fixes only).
4. **`unknown` version fallback**: Fall back safely to V1 (`effectiveProfile: "v1"`) while emitting an explicit degraded warning in `asd sync` / `asd doctor` (plus `ASD_OPENCODE_PROFILE=v1|v2` override for tests/CI).
5. **Module layout & Core Purity (`HC-1`)**: Keep `src/adapters/opencode.ts` as the canonical V2-first OpenCode module (no `opencode-v2.ts`), isolate frozen V1 code exclusively in `src/adapters/opencode-v1.ts` before adding V2 code, and place pure version/capability detection in `src/core/opencode-profile.ts` so `src/core/*` never imports `../adapters`.

---

## 9. Appendix: Evidence Index

- V1 plugin: `src/adapters/opencode.ts:90-366`, `src/adapters/installer.ts:1195-1197`, `:2078`, `:793`, `:2514`
- V1 session ID plumbing: `src/core/types.ts:352-353`, `:381`, `src/cli/index.ts:166`, `:345-349`, `:2076`, `src/orchestrator/dispatch-handler.ts:845`
- V1 skills/docs: `src/skills/asd-run/SKILL.md:51`, `src/skills/asd/SKILL.md:57`, `README.md:24,70-71,109,123-124`, `docs/ACP_ROADMAP.md:16,51-55`
- Generic async: `src/orchestrator/dispatch-handler.ts:823-950`, `src/core/subagent-control.ts:800-880`, `src/cli/index.ts:272,1311,1427,2085-2100`
- Shared adapter surface: see the table in 3.3
