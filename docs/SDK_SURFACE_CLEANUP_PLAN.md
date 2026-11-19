# SDK Surface Cleanup Plan (SDK_SURFACE_CLEANUP_PLAN.md)

**English** | [한국어](./SDK_SURFACE_CLEANUP_PLAN_ko.md)

> **Background** (2026-11-10): Because ASD-Nexus is being rewritten from scratch, the burden of maintaining backward compatibility for legacy consumers is lifted. This document records the candidate symbols to remove from the public SDK surface, along with their rationale and removal conditions, determined by filtering the full `ponytail-audit` results through "external compatibility / maintainability / project goals".

---

## 0. Documentation–Code Mismatch (Resolved — This Change, T4.2)

**Removed `startDashboardServer` root export.**
- Removed the `startDashboardServer` / `type DashboardServerHandle` root exports from `src/index.ts`.
- Code now matches the "not exposed from root entry; dedicated to `cli/dashboard` subpath" specification in [`CORE_GUI_BOUNDARY_AUDIT.md`](./CORE_GUI_BOUNDARY_AUDIT.md) W2, `PROJECT_STATUS.md` 4.1, and `PATCH_NOTES.md` (v2.4.3).
- Migrated the root export pin in `tests/dashboard-exports.test.ts` (formerly line 101) to a `cli/dashboard` subpath import (accompanied by test file update).
- The `./cli/dashboard` (`agent-swarm-director/cli/dashboard.ts`) subpath remains supported (`package.json` `./cli/*` → `./src/cli/*.ts`).

---

## 1. Removal Candidates

| # | Symbol | Location | Current Status | Pins / Docs | Removal Condition |
|---|------|------|-----------|---------|-----------|
| 1 | `startDashboardServer` (root export) | `src/index.ts` | Removed (this change, T4.2) | `dashboard-exports.test.ts:101` pin → migrated to `cli/dashboard` subpath import | Completed. Subpath `./cli/dashboard` is retained |
| 2 | `installGlobalConfigs` | `installer.ts:1525` | Unused alias of `syncHarnessConfigs` | No pins, no docs | Ready for immediate removal |
| 3 | `registerCoreHarnessProvisioner` / `getCoreHarnessProvisioner` | `types.ts:523-524` | Unused aliases of registry functions | No pins, no docs | Ready for immediate removal |
| 4 | `syncRepoVersionStrings` | `installer.ts:973-975` | Intentional no-op (design note comment) | `installer-sync.test.ts:482` pins no-op behavior | Remove function + delete that test case. Historical doc immutability continues to be verified by `syncHarnessConfigs` tests |
| 5 | `approveTaskWorktree` / `rejectTaskWorktree` | `workspace.ts:1810,1881` | Aliases of `approve/rejectPendingTask` | `dashboard-exports.test.ts:105-108` pins identity | Remove aliases + delete 2 test assertions |
| 6 | `isProtectedPath` | `policy.ts:309` | Alias of `checkProtectedPath` | Imported in `policy-failclosed.test.ts:15` | Remove alias + migrate test import |
| 7 | `buildResumeHarnessCommand` positional signature | `session-tracker.ts:179-204` | Dual support for positional + options object | Docs (`PROJECT_STATUS` / SDK reference) document only the options form. 1 internal positional caller (`subagent-control.ts:452`) | Narrow to options-only + update the 1 internal caller |
| 8 | `expectedStartedAt` in `verifyPidIdentity(pid, expectedStartedAt)` | `workspace.ts:1239-1242` | Stub parameter ignored via `void`. 2 call sites pass a value | Undocumented | Either (a) implement start-time verification, or (b) remove parameter + clean up 2 call sites. Because it changes the signature, decide during the Nexus rewrite |
| 9 | `src/adapters/claude.ts` | 5-line re-export alias | 0 internal imports (confirmed via grep) | No doc references | Removable. However, removing it breaks the `agent-swarm-director/adapters/claude` subpath import, requiring a minor version bump |

### Confirmed Retentions (Do Not Remove)
- **`package.json` `.ts` export patterns** (4 lines such as `./core/*.ts`): Load-bearing. Keeping only `./core/*` causes a request for `./core/db.ts` to substitute `*` = `db.ts` and look up `db.ts.ts`. Explicit `.ts` patterns resolve `.ts` subpath imports. (Initially misclassified as "duplicate" during audit → withdrawn)
- **All adapter files other than `claude.ts`, `presets/`, and `scripts/run-tests.mjs`**: All actively used.
- **All root and design documents such as [`ORCHESTRATOR_APP_PLAN.md`](./ORCHESTRATOR_APP_PLAN.md) / `ROUTING_GUIDE.md`**: Cross-reference network (`PATCH_NOTES`, `PROJECT_STATUS`, `HARNESS_INTEGRATION_REFERENCE`) is active, so retain all of them. Only untracked temporary junk files were removed (`-/` directory and an untitled default text file under `.omo/`).

---

## 2. Removal Procedure (When Starting the Nexus Rewrite)

1. Remove items 1–9 in the table above in a single commit (or small per-item commits), accompanied by the test updates listed in the "Removal Condition" column.
2. Delete the removed symbols from the per-module export tables in `EXTERNAL_SDK_REFERENCE.md` and update the public surface section in `PROJECT_STATUS.md`.
3. When removing `startDashboardServer`, align the W2 status in [`CORE_GUI_BOUNDARY_AUDIT.md`](./CORE_GUI_BOUNDARY_AUDIT.md) with the actual code and record the regression cause (the commit where it was re-added) in the patch notes.
4. Bump the package version by at least a minor version (removing a subpath is a breaking change).

## 3. ASD-Nexus Migration Checklist

- [ ] Extract the list of symbols Nexus imports from the `agent-swarm-director` root entry (`.`) and cross-check against the table above
- [ ] If `startDashboardServer` is used, replace it with Nexus's own server (belongs to the GUI under the boundary principle)
- [ ] Check for positional `buildResumeHarnessCommand` calls → migrate to the options object form
- [ ] Check whether any caller depends on the second argument of `verifyPidIdentity` (currently ignored, so nothing should rely on it)
- [ ] Check for `adapters/claude` subpath imports → migrate to `adapters/claude-code`

## 4. Reference: Zero-Risk Cleanup (Already Completed, 2026-11-10)

- Deleted dead block in `mcp/server.ts` `buildPromptForTask` (kept delegation only; output unchanged)
- Consolidated 2 duplicate lock implementations → single implementation in `core/file-lock.ts` (preserved timeout, backoff, and error-label behavior; CR-11 tests pass)
- Delegated `buildDefaultHarnessCommand` → `buildHeadlessHarnessCommand` (eliminated command-table drift)
- Consolidated 3 copies of `detectSystemLocale` → 1 in `models.ts`, and 3 copies of `resolveHome` → 1 in `config.resolveHomeDir`
- Unified `probeHeadlessBinary`, hoisted `toStringArray`, and removed duplicate re-exports in the root barrel
- Verification: `scripts/run-tests.mjs` 405/405 passed
