/**
 * ASD Orchestrator — Dispatch Handler (`src/orchestrator/dispatch-handler.ts`).
 *
 * Handles `asd dispatch` across `claim_only` (DIRECT/LIGHT) and `parallel_spawn`
 * (HEAVY), enforces same-turn LIGHT `targetFiles` overlap warnings, persists
 * best-effort token/cost telemetry, processes Cross-Scope follow-up requests,
 * and returns concise results with `logPath` pointers.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { syncAgentModelsIfNeeded } from "../adapters/installer.ts";
import { loadRoutingConfig } from "../core/config.ts";
import type { SqliteDriver, TaskRow } from "../core/db.ts";
import { buildDefaultHarnessCommand, spawnHybridSubagent } from "../core/debate.ts";
import { resolveOpenCodeCapabilityProfile } from "../core/opencode-profile.ts";
import {
  checkProtectedPath,
  isPathAllowed,
  verifyChangedFilesBoundary,
} from "../core/policy.ts";
import {
  atomicWriteFileSync,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
} from "../core/render.ts";
import {
  detectLiveRuntimeCapabilities,
  escalateTaskRoute,
  isFallbackTriggerOutput,
  normalizeAntigravityModel,
  resolveBinaryOnPath,
  resolveRoute,
  runWithFallbacks,
  type ResolvedRoute,
} from "../core/router.ts";
import { buildPromptForTask as buildCorePromptForTask } from "../core/session-services.ts";
import { linkHarnessSessionToAsdSession } from "../core/session-tracker.ts";
import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  extractTelemetryFromOutput,
  finalizeSubagentArtifacts,
} from "../core/spawner.ts";
import {
  expandTaskAllowedFiles,
  readAsyncDispatchJob,
  writeAsyncDispatchJob,
} from "../core/subagent-control.ts";
import type {
  AgentRole,
  AsdDispatchInput,
  AsdDispatchOutput,
  AsyncDispatchJobMeta,
  AutoCreatedCrossScopeTask,
  CrossScopeRequest,
  DeferredCrossScopeRequest,
  DifficultyTier,
  DoneClaim,
  HarnessId,
  TaskStatus,
  TaskTelemetry,
  TaskTrack,
} from "../core/types.ts";
import {
  cleanupWorktree,
  createTaskWorktree,
  getChangedFiles,
  isInPlaceTrack,
  prepareBaseline,
  recoverOrphanedTasks,
  rollbackLightChanges,
  type TaskWorktreeInfo,
  verifyAndCommitLightTask,
  verifyAndMergeHeavyTask,
} from "../core/workspace.ts";
import type { OrchestratorContext } from "./index.ts";
import { findOverlappingLightTargetFiles } from "./plan-handler.ts";

// ============================================================================
// Subagent Report Parsing & Cross-Scope Constants
// ============================================================================

export const MAX_AUTO_CROSS_SCOPE_PER_TASK = 2;
export const MAX_CROSS_SCOPE_CHAIN_DEPTH = 2;

export interface ParsedSubagentReport {
  summary?: string;
  key_decisions?: string[];
  risks?: string[];
  cross_scope_requests?: CrossScopeRequest[];
}

function unwrapNdjsonReportText(rawOutput: string): string {
  const parts: string[] = [];
  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (!obj || typeof obj !== "object") continue;
      if (typeof obj.result === "string") parts.push(obj.result);
      if (obj.result && typeof obj.result === "object") {
        const resRec = obj.result as Record<string, unknown>;
        if (typeof resRec.response === "string") parts.push(resRec.response);
      }
      if (obj.step_update && typeof obj.step_update === "object") {
        const su = obj.step_update as Record<string, unknown>;
        if (typeof su.text_delta === "string") parts.push(su.text_delta);
      }
      if (obj.delta && typeof obj.delta === "object") {
        const d = obj.delta as Record<string, unknown>;
        if (typeof d.text === "string") parts.push(d.text);
      }
      if (obj.part && typeof obj.part === "object") {
        const p = obj.part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
      }
      if (obj.message && typeof obj.message === "object") {
        const msg = obj.message as Record<string, unknown>;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (
              b &&
              typeof b === "object" &&
              typeof (b as Record<string, unknown>).text === "string"
            ) {
              parts.push(String((b as Record<string, unknown>).text));
            }
          }
        }
      }
    } catch {
      // ignore malformed NDJSON line
    }
  }
  return parts.join("");
}

/**
 * Extracts structured `asd-report` (or trailing JSON report) emitted by a subagent
 * from its stdout/stderr log (supporting both raw/ACP text and escaped NDJSON stream-json envelopes).
 */
export function parseSubagentReport(rawOutput: string): ParsedSubagentReport | null {
  if (!rawOutput || typeof rawOutput !== "string") return null;

  const collectFenced = (source: string): string[] => {
    const found: string[] = [];
    const fencedRegex = /```(?:asd-report|json)\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fencedRegex.exec(source)) !== null) {
      if (m[1]?.trim()) {
        found.push(m[1].trim());
      }
    }
    return found;
  };

  const candidates = collectFenced(rawOutput);
  if (rawOutput.includes("{")) {
    const unwrapped = unwrapNdjsonReportText(rawOutput);
    if (unwrapped) {
      candidates.push(...collectFenced(unwrapped));
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        ("cross_scope_requests" in parsed ||
          "key_decisions" in parsed ||
          "risks" in parsed ||
          "summary" in parsed)
      ) {
        const rawReqs = Array.isArray(parsed.cross_scope_requests)
          ? parsed.cross_scope_requests
          : [];
        const validReqs: CrossScopeRequest[] = [];
        for (const item of rawReqs) {
          if (!item || typeof item !== "object") continue;
          const r = item as Record<string, unknown>;
          const targetFile =
            typeof r.target_file === "string" ? r.target_file.trim() : "";
          const reason = typeof r.reason === "string" ? r.reason.trim() : "";
          const suggestedChange =
            typeof r.suggested_change === "string" ? r.suggested_change.trim() : "";
          if (!targetFile || !reason) continue;
          const callerFiles = Array.isArray(r.caller_files)
            ? r.caller_files
                .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
                .map((f) => f.trim())
            : undefined;
          validReqs.push({
            target_file: targetFile,
            ...(callerFiles && callerFiles.length > 0 ? { caller_files: callerFiles } : {}),
            reason,
            suggested_change: suggestedChange || reason,
          });
        }

        return {
          summary: typeof parsed.summary === "string" ? parsed.summary.trim() : undefined,
          key_decisions: Array.isArray(parsed.key_decisions)
            ? parsed.key_decisions.filter((d): d is string => typeof d === "string")
            : undefined,
          risks: Array.isArray(parsed.risks)
            ? parsed.risks.filter((d): d is string => typeof d === "string")
            : undefined,
          cross_scope_requests: validReqs.length > 0 ? validReqs : undefined,
        };
      }
    } catch {
      // ignore malformed JSON block
    }
  }

  return null;
}

// ============================================================================
// Cross-Scope Follow-up Scheduler & Board Formatter
// ============================================================================

export function processCrossScopeRequests(
  db: SqliteDriver,
  sessionId: string,
  currentTurn: number,
  taskBatches: Array<{ taskId: string; requests: CrossScopeRequest[] }>
): {
  autoCreatedTasks: AutoCreatedCrossScopeTask[];
  deferredCrossScopeRequests: DeferredCrossScopeRequest[];
} {
  const autoCreatedTasks: AutoCreatedCrossScopeTask[] = [];
  const deferredCrossScopeRequests: DeferredCrossScopeRequest[] = [];
  if (taskBatches.length === 0) {
    return { autoCreatedTasks, deferredCrossScopeRequests };
  }

  const allTasks = db.getSessionTasks(sessionId);
  const taskById = new Map<string, TaskRow>(allTasks.map((t) => [t.task_id, t]));

  const getCrossScopeChainDepth = (
    taskId: string,
    visited = new Set<string>()
  ): number => {
    if (visited.has(taskId)) return 0;
    visited.add(taskId);
    const row = taskById.get(taskId);
    if (!row) return 0;
    const isCrossScope =
      row.is_cross_scope === 1 || row.title.startsWith("[Cross-Scope");
    let deps: string[] = [];
    try {
      deps = JSON.parse(row.depends_on_json || "[]");
    } catch {
      deps = [];
    }
    let maxUpstream = 0;
    for (const depId of deps) {
      maxUpstream = Math.max(maxUpstream, getCrossScopeChainDepth(depId, visited));
    }
    return (isCrossScope ? 1 : 0) + maxUpstream;
  };

  interface EligibleEntry {
    callerTask: TaskRow;
    callerAllowedFiles: string[];
    callerChangedFiles: string[];
    req: CrossScopeRequest;
  }

  const eligibleByTargetFile = new Map<string, EligibleEntry[]>();

  for (const batch of taskBatches) {
    const callerTask = taskById.get(batch.taskId);
    if (!callerTask) continue;

    const chainDepth = getCrossScopeChainDepth(batch.taskId);
    if (chainDepth >= MAX_CROSS_SCOPE_CHAIN_DEPTH) {
      for (const req of batch.requests) {
        deferredCrossScopeRequests.push({
          requestedByTaskId: batch.taskId,
          target_file: req.target_file,
          caller_files: req.caller_files,
          reason: req.reason,
          suggested_change: req.suggested_change,
          deferReason: `Exceeded maximum cross-scope chain depth (${MAX_CROSS_SCOPE_CHAIN_DEPTH}); Main Agent review required`,
        });
      }
      continue;
    }

    let callerAllowedFiles: string[] = [];
    try {
      callerAllowedFiles = JSON.parse(callerTask.target_files_json || "[]");
    } catch {
      callerAllowedFiles = [];
    }

    let callerChangedFiles: string[] = [];
    if (callerTask.done_claim_json) {
      try {
        const parsedClaim = JSON.parse(callerTask.done_claim_json) as DoneClaim;
        if (Array.isArray(parsedClaim.changed_files)) {
          callerChangedFiles = parsedClaim.changed_files;
        }
      } catch {
        callerChangedFiles = [];
      }
    }

    let acceptedCountForTask = 0;
    for (const req of batch.requests) {
      const cleanTarget = req.target_file
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .trim();
      if (!cleanTarget) continue;

      const prot = checkProtectedPath(cleanTarget);
      if (prot.protected) {
        deferredCrossScopeRequests.push({
          requestedByTaskId: batch.taskId,
          target_file: cleanTarget,
          caller_files: req.caller_files,
          reason: req.reason,
          suggested_change: req.suggested_change,
          deferReason: prot.reason || "Target path is protected",
        });
        continue;
      }

      if (acceptedCountForTask >= MAX_AUTO_CROSS_SCOPE_PER_TASK) {
        deferredCrossScopeRequests.push({
          requestedByTaskId: batch.taskId,
          target_file: cleanTarget,
          caller_files: req.caller_files,
          reason: req.reason,
          suggested_change: req.suggested_change,
          deferReason: `Exceeded max ${MAX_AUTO_CROSS_SCOPE_PER_TASK} auto cross-scope requests per subagent; deferred to Main Agent`,
        });
        continue;
      }

      acceptedCountForTask++;
      const list = eligibleByTargetFile.get(cleanTarget) ?? [];
      list.push({
        callerTask,
        callerAllowedFiles,
        callerChangedFiles,
        req: { ...req, target_file: cleanTarget },
      });
      eligibleByTargetFile.set(cleanTarget, list);
    }
  }

  if (eligibleByTargetFile.size === 0) {
    return { autoCreatedTasks, deferredCrossScopeRequests };
  }

  const nextTurn = currentTurn + 1;
  const existingNextTurnTasks = allTasks.filter((t) => t.turn === nextTurn);
  let nextIdx = existingNextTurnTasks.length + 1;
  const existingIds = new Set(allTasks.map((t) => t.task_id));

  const tasksToInsert: Array<{
    taskId: string;
    turn: number;
    title: string;
    track: TaskTrack;
    role: AgentRole;
    category: string;
    difficulty: DifficultyTier;
    dependsOn: string[];
    targetFiles: string[];
    contextHint: string;
    acceptance: string;
    verifyCmd: string | null;
    isCrossScope: boolean;
  }> = [];

  for (const [targetFile, entries] of eligibleByTargetFile.entries()) {
    while (existingIds.has(`T${nextTurn}.${nextIdx}`)) {
      nextIdx++;
    }
    const newTaskId = `T${nextTurn}.${nextIdx}`;
    existingIds.add(newTaskId);
    nextIdx++;

    const ownerTasks: TaskRow[] = [];
    for (const candidate of allTasks) {
      if (candidate.turn > currentTurn) continue;
      let candFiles: string[] = [];
      try {
        candFiles = JSON.parse(candidate.target_files_json || "[]");
      } catch {
        candFiles = [];
      }
      if (isPathAllowed(targetFile, candFiles)) {
        ownerTasks.push(candidate);
      }
    }

    const bundledFiles = new Set<string>([targetFile]);
    for (const entry of entries) {
      const requestedCallers = (entry.req.caller_files ?? [])
        .map((f) => f.replaceAll("\\", "/").replace(/^\.\//, "").trim())
        .filter(
          (f) =>
            f.length > 0 &&
            !checkProtectedPath(f).protected &&
            (isPathAllowed(f, entry.callerAllowedFiles) ||
              entry.callerChangedFiles.includes(f))
        );

      if (requestedCallers.length > 0) {
        for (const cf of requestedCallers.slice(0, 2)) {
          bundledFiles.add(cf);
        }
      } else {
        const autoPool =
          entry.callerChangedFiles.length > 0
            ? entry.callerChangedFiles
            : entry.callerAllowedFiles.filter((f) => !f.includes("*"));
        for (const cf of autoPool.slice(0, 2)) {
          const cleanCf = cf.replaceAll("\\", "/").replace(/^\.\//, "").trim();
          if (cleanCf && !checkProtectedPath(cleanCf).protected) {
            bundledFiles.add(cleanCf);
          }
        }
      }
    }

    const dependsOnSet = new Set<string>();
    const requestedBySet = new Set<string>();
    for (const entry of entries) {
      dependsOnSet.add(entry.callerTask.task_id);
      requestedBySet.add(entry.callerTask.task_id);
    }
    for (const owner of ownerTasks) {
      dependsOnSet.add(owner.task_id);
    }

    const primaryOwner = ownerTasks[0] ?? entries[0]!.callerTask;
    const targetFilesArr = Array.from(bundledFiles);
    const dependsOnArr = Array.from(dependsOnSet);
    const requestedByArr = Array.from(requestedBySet);

    const sanitizeInline = (s: string) =>
      s.replace(/[|()\r\n]+/g, " ").replace(/\s+/g, " ").trim();

    const reasonsSummary = entries
      .map((e) => `[from ${e.callerTask.task_id}] ${sanitizeInline(e.req.reason)}`)
      .join("; ");
    const changesSummary = entries
      .map((e) => `[from ${e.callerTask.task_id}] ${sanitizeInline(e.req.suggested_change)}`)
      .join("; ");

    const track: TaskTrack =
      targetFilesArr.length > 1 ||
      ownerTasks.some((o) => o.track === "HEAVY") ||
      entries.some((e) => e.callerTask.track === "HEAVY")
        ? "HEAVY"
        : "LIGHT";

    const title = `[Cross-Scope from ${requestedByArr.join(",")}] Update ${targetFile}`;

    tasksToInsert.push({
      taskId: newTaskId,
      turn: nextTurn,
      title,
      track,
      role: (primaryOwner.role as AgentRole) || "worker",
      category: primaryOwner.category || "general",
      difficulty: (primaryOwner.difficulty as DifficultyTier) || "medium",
      dependsOn: dependsOnArr,
      targetFiles: targetFilesArr,
      contextHint: reasonsSummary,
      acceptance: changesSummary,
      verifyCmd: primaryOwner.verify_cmd ?? entries[0]!.callerTask.verify_cmd ?? null,
      isCrossScope: true,
    });

    autoCreatedTasks.push({
      taskId: newTaskId,
      turn: nextTurn,
      title,
      targetFiles: targetFilesArr,
      dependsOn: dependsOnArr,
      requestedBy: requestedByArr,
    });
  }

  if (tasksToInsert.length > 0) {
    db.withImmediateTx(() => {
      db.upsertTasks(sessionId, tasksToInsert);
      db.incrementStateVersion(sessionId);
    });
  }

  return { autoCreatedTasks, deferredCrossScopeRequests };
}

export function appendCrossScopeSummaryToBoard(
  progressBoard: string,
  autoCreatedTasks: AutoCreatedCrossScopeTask[],
  deferredCrossScopeRequests: DeferredCrossScopeRequest[]
): string {
  if (autoCreatedTasks.length === 0 && deferredCrossScopeRequests.length === 0) {
    return progressBoard;
  }
  const extra: string[] = [progressBoard, ""];
  if (autoCreatedTasks.length > 0) {
    extra.push("#### 🔄 Auto-Created Cross-Scope Follow-up Tasks (max 2/sub-harness)");
    for (const t of autoCreatedTasks) {
      extra.push(
        `- **${t.taskId}** (Turn ${t.turn}, requested by: ${t.requestedBy.join(", ")}, depends on: ${t.dependsOn.join(", ")}) → bundled files: \`${t.targetFiles.join("`, `")}\``
      );
    }
    extra.push("");
  }
  if (deferredCrossScopeRequests.length > 0) {
    extra.push("#### ⚠️ Main Agent Review Required (Deferred Cross-Scope Requests)");
    for (const d of deferredCrossScopeRequests) {
      extra.push(
        `- **[Requested by: ${d.requestedByTaskId}]** target: \`${d.target_file}\` — reason: ${d.reason} / suggested change: ${d.suggested_change} *(defer reason: ${d.deferReason})*`
      );
    }
    extra.push("");
  }
  return extra.join("\n").trimEnd();
}

// ============================================================================
// Dispatch Command Handler
// ============================================================================

export async function executeDispatch(
  ctx: OrchestratorContext,
  input: AsdDispatchInput,
  signal?: AbortSignal,
  dispatchOpts?: { detachAsyncWorker?: boolean }
): Promise<AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] }> {
  if (ctx.isSubagent()) {
    throw new Error("Subagents cannot invoke orchestration tools");
  }
  const sessionId =
    input.sessionId?.trim() ||
    ctx.resolveImplicitSessionId({ mutating: false, action: "dispatch" }) ||
    input.sessionId;
  let sessionRow = ctx.db.getSession(sessionId);
  if (!sessionRow) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // CR-04: Attach/switch CLI driver on dispatch when called from CLI (not driver / subagent)
  if (
    ctx.sessionRole !== "driver" &&
    process.env.ASD_SESSION_ROLE !== "driver" &&
    !ctx.isSubagent()
  ) {
    linkHarnessSessionToAsdSession({
      projectRoot: ctx.projectRoot,
      homeDir: ctx.homeDir,
      asdSessionId: sessionId,
      harness: (input.harness || sessionRow.main_harness) as HarnessId,
      source: "cli-asd",
      db: ctx.db,
    });
    sessionRow = ctx.db.getSession(sessionId) ?? sessionRow;
  }

  const session = sessionRow;
  syncAgentModelsIfNeeded({ homeDir: ctx.homeDir, projectRoot: ctx.projectRoot });
  prepareBaseline(ctx.projectRoot, { sessionId, db: ctx.db });
  recoverOrphanedTasks({ db: ctx.db, projectRoot: ctx.projectRoot, sessionId });

  const allTasks = ctx.db.getSessionTasks(sessionId);

  let selectedTurn: number;
  if (input.turn !== undefined) {
    selectedTurn = input.turn;
  } else {
    const unfinished = allTasks.filter((t) => t.status !== "done");
    if (unfinished.length === 0) {
      const board = renderProgressBoard(session, allTasks);
      return {
        sessionId,
        turn: 0,
        dispatchedTasks: [],
        results: [],
        progressBoard: board,
      };
    }
    const turns = [...new Set(unfinished.map((t) => t.turn))].sort((a, b) => a - b);
    selectedTurn = turns[0] ?? 1;
  }

  let turnTasks = allTasks.filter((t) => t.turn === selectedTurn);
  if (input.taskIds && input.taskIds.length > 0) {
    const allowed = new Set(input.taskIds);
    turnTasks = turnTasks.filter((t) => allowed.has(t.task_id));
  }

  // Default track behavior:
  // - DIRECT & LIGHT tasks default to 'claim_only' (in-place execution without external CLI spawn)
  // - HEAVY tasks default to 'parallel_spawn' (multi-harness execution in isolated worktrees)
  const mode =
    input.mode ??
    (turnTasks.length > 0 && turnTasks.every((t) => isInPlaceTrack(t.track))
      ? "claim_only"
      : "parallel_spawn");

  const taskMap = new Map(allTasks.map((t) => [t.task_id, t]));

  const taskUpstreamContext = new Map<
    string,
    { valid: boolean; missingDeps: string[]; upstreamDecisions: string[]; upstreamFiles: string[] }
  >();

  for (const t of turnTasks) {
    let dependsOn: string[] = [];
    try {
      dependsOn = JSON.parse(t.depends_on_json || "[]");
    } catch {
      dependsOn = [];
    }

    const missingDeps: string[] = [];
    const upstreamDecisions: string[] = [];
    const upstreamFiles: string[] = [];

    for (const depId of dependsOn) {
      const depTask = taskMap.get(depId);
      if (!depTask || depTask.status !== "done") {
        missingDeps.push(depId);
      } else if (depTask.done_claim_json) {
        try {
          const claim = JSON.parse(depTask.done_claim_json) as DoneClaim;
          if (Array.isArray(claim.key_decisions)) {
            upstreamDecisions.push(...claim.key_decisions);
          }
          if (Array.isArray(claim.changed_files)) {
            upstreamFiles.push(...claim.changed_files);
          }
        } catch {
          // ignore
        }
      }
    }

    taskUpstreamContext.set(t.task_id, {
      valid: missingDeps.length === 0,
      missingDeps,
      upstreamDecisions,
      upstreamFiles,
    });
  }

  // 2. Mode: claim_only
  if (mode === "claim_only") {
    const results: AsdDispatchOutput["results"] = [];
    const lightConcurrencyWarnings = findOverlappingLightTargetFiles(
      turnTasks.map((t) => {
        let tf: string[] = [];
        try {
          tf = JSON.parse(t.target_files_json || "[]");
        } catch {
          tf = [];
        }
        return { taskId: t.task_id, turn: t.turn, track: t.track, targetFiles: tf };
      })
    );

    for (const t of turnTasks) {
      const upCtx = taskUpstreamContext.get(t.task_id)!;
      if (!upCtx.valid) {
        results.push({
          taskId: t.task_id,
          status: t.status as TaskStatus,
          harness: (t.assigned_harness as HarnessId) ?? "opencode",
          model: t.assigned_model ?? "z-ai/glm-5.3-flash",
          durationMs: 0,
          error: `Upstream dependencies not satisfied: ${upCtx.missingDeps.join(", ")}`,
        });
        continue;
      }
      if (!ctx.db.tryClaimTask(sessionId, t.task_id)) {
        continue;
      }

      const preferredHarness =
        input.harness ??
        (t.assigned_harness as HarnessId | null) ??
        (isInPlaceTrack(t.track) ? (session.main_harness as HarnessId) : undefined);

      const route = resolveRoute({
        role: t.role as AgentRole,
        category: t.category,
        difficulty: t.difficulty as DifficultyTier,
        harness: preferredHarness,
        model: t.assigned_model ?? undefined,
        isSubagentSpawn: true,
        mainHarness: session.main_harness as HarnessId,
        mode: "claim_only",
      });

      const effectiveModel =
        route.harness === "antigravity"
          ? normalizeAntigravityModel(route.model)
          : route.model;

      let wtPath: string | undefined;
      let taskLogPath: string | undefined;
      if (t.track === "HEAVY") {
        const wt = createTaskWorktree(ctx.projectRoot, t.turn, t.task_id);
        wtPath = wt.wtPath;

        const subSessionId = `sub-${t.turn}-${t.task_id}-${t.role}-${route.harness}`;
        let allowedFiles: string[] = [];
        try {
          allowedFiles = JSON.parse(t.target_files_json || "[]");
        } catch {
          allowedFiles = [];
        }
        if (allowedFiles.length > 0 && !allowedFiles.includes("tests/**")) {
          allowedFiles = [...allowedFiles, "tests/**", "**/*.test.ts", "**/*.spec.ts"];
        }
        const subDir = path.join(
          ctx.projectRoot,
          ".asd",
          "sessions",
          sessionId,
          "subagents",
          subSessionId
        );
        fs.mkdirSync(subDir, { recursive: true });
        const promptText = buildCorePromptForTask(
          t,
          upCtx.upstreamDecisions,
          upCtx.upstreamFiles
        );
        const startedAt = Date.now();
        atomicWriteFileSync(path.join(subDir, "prompt.md"), promptText);
        atomicWriteFileSync(
          path.join(subDir, "meta.json"),
          JSON.stringify(
            {
              subSessionId,
              parentSessionId: sessionId,
              roleType: "subagent",
              role: t.role,
              harness: route.harness,
              model: effectiveModel,
              taskId: t.task_id,
              pid: process.pid,
              ownerPid: process.pid,
              dispatchMode: "claim_only",
              worktreePath: wtPath ?? null,
              allowedFiles,
              status: "running",
              startedAt,
            },
            null,
            2
          ) + "\n"
        );
        taskLogPath = path.join(subDir, "output.log");
        if (!fs.existsSync(taskLogPath)) {
          atomicWriteFileSync(
            taskLogPath,
            `[claim_only] Task ${t.task_id} claimed by @${route.harness}/${effectiveModel} at ${new Date(startedAt).toISOString()}\n`
          );
        }

        ctx.db.updateTaskStatus(sessionId, t.task_id, "running", {
          assignedHarness: route.harness,
          assignedModel: effectiveModel,
          worktreePath: wtPath,
          subSessionId,
        });
      } else {
        ctx.db.updateTaskStatus(sessionId, t.task_id, "running", {
          assignedHarness: null,
          assignedModel: null,
          worktreePath: null,
          subSessionId: null,
        });
      }

      results.push({
        taskId: t.task_id,
        status: "running",
        harness: route.harness,
        model: effectiveModel,
        durationMs: 0,
        ...(taskLogPath ? { logPath: taskLogPath } : {}),
      });
    }

    const freshTasks = ctx.db.getSessionTasks(sessionId);
    renderPlanMd(session, freshTasks);
    const progressBoard = renderProgressBoard(session, freshTasks);

    return {
      sessionId,
      turn: selectedTurn,
      dispatchedTasks: results,
      results,
      ...(lightConcurrencyWarnings.length > 0
        ? { concurrencyWarnings: lightConcurrencyWarnings }
        : {}),
      progressBoard,
    };
  }

  // 3. Mode: parallel_spawn
  if (input.async === true && turnTasks.length > 0) {
    const jobId = `async-${sessionId}-t${selectedTurn}-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const pendingResults: AsdDispatchOutput["results"] = turnTasks.map((t) => ({
      taskId: t.task_id,
      status: "running" as TaskStatus,
      harness:
        input.harness ??
        (t.assigned_harness as HarnessId | null) ??
        (session.main_harness as HarnessId) ??
        "opencode",
      model: t.assigned_model ?? "default",
      durationMs: 0,
    }));
    const initialBoard = renderProgressBoard(session, allTasks);
    const usesV1SessionCallback =
      resolveOpenCodeCapabilityProfile().usesV1SessionCallback;
    let asyncJob: AsyncDispatchJobMeta = {
      jobId,
      sessionId,
      turn: selectedTurn,
      status: "running",
      workerPid: process.pid,
      startedAt,
      ...(usesV1SessionCallback
        ? {
            ...(input.openCodeSessionId
              ? { openCodeSessionId: input.openCodeSessionId }
              : {}),
            notified: false,
          }
        : {}),
      progressBoard: initialBoard,
      results: pendingResults,
    };
    writeAsyncDispatchJob(ctx.projectRoot, asyncJob, ctx.homeDir);

    if (
      dispatchOpts?.detachAsyncWorker &&
      !ctx.commandRunner &&
      !ctx.acpCommandOverride
    ) {
      const cliScriptPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../cli/index.ts"
      );
      const workerArgs = [
        "--no-warnings",
        cliScriptPath,
        "dispatch",
        "--session",
        sessionId,
        "--turn",
        String(selectedTurn),
        "--mode",
        "parallel_spawn",
        "--project-root",
        ctx.projectRoot,
      ];
      if (ctx.homeDir) {
        workerArgs.push("--home", ctx.homeDir);
      }
      if (input.harness) {
        workerArgs.push("--harness", input.harness);
      }
      if (input.transport) {
        workerArgs.push("--transport", input.transport);
      }
      if (input.taskIds && input.taskIds.length > 0) {
        workerArgs.push("--task", input.taskIds.join(","));
      }
      const child = child_process.spawn(process.execPath, workerArgs, {
        cwd: ctx.projectRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          ASD_ASYNC_WORKER_ACTIVE: "1",
        },
      });
      child.unref();
      asyncJob = {
        ...asyncJob,
        workerPid: child.pid ?? 0,
      };
      writeAsyncDispatchJob(ctx.projectRoot, asyncJob, ctx.homeDir);
    } else {
      const bgOrchestrator = ctx.createBackgroundOrchestrator();
      void bgOrchestrator
        .handleDispatch({ ...input, async: false, turn: selectedTurn }, signal)
        .then((completed) => {
          const anyFailed = completed.results.some(
            (r) => r.status === "failed" || r.status === "merge_conflict"
          );
          const doneSummary = completed.results
            .map(
              (r) =>
                `- ${r.taskId}: ${r.status} (@${r.harness}/${r.model})${r.error ? ` [${r.error}]` : ""}`
            )
            .join("\n");
          const existingJob =
            readAsyncDispatchJob(ctx.projectRoot, sessionId, ctx.homeDir) ?? asyncJob;
          writeAsyncDispatchJob(
            ctx.projectRoot,
            {
              ...existingJob,
              status: anyFailed ? "failed" : "done",
              finishedAt: Date.now(),
              summary: doneSummary,
              progressBoard: completed.progressBoard,
              results: completed.results,
              ...(completed.autoCreatedTasks
                ? { autoCreatedTasks: completed.autoCreatedTasks }
                : {}),
              ...(completed.deferredCrossScopeRequests
                ? { deferredCrossScopeRequests: completed.deferredCrossScopeRequests }
                : {}),
            },
            ctx.homeDir
          );
        })
        .catch((err: unknown) => {
          const existingJob =
            readAsyncDispatchJob(ctx.projectRoot, sessionId, ctx.homeDir) ?? asyncJob;
          writeAsyncDispatchJob(
            ctx.projectRoot,
            {
              ...existingJob,
              status: "failed",
              finishedAt: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            },
            ctx.homeDir
          );
        })
        .finally(() => {
          bgOrchestrator.close();
        });
    }

    return {
      sessionId,
      turn: selectedTurn,
      async: true,
      asyncJob,
      dispatchedTasks: pendingResults,
      results: pendingResults,
      progressBoard: initialBoard,
    };
  }

  const acpBridgeHintsSet = new Set<string>();
  const spawnPromises = turnTasks.map(async (t) => {
    const upCtx = taskUpstreamContext.get(t.task_id)!;
    if (!upCtx.valid) {
      return {
        taskId: t.task_id,
        status: t.status as TaskStatus,
        harness: (t.assigned_harness as HarnessId) ?? "opencode",
        model: t.assigned_model ?? "z-ai/glm-5.3-flash",
        durationMs: 0,
        error: `Upstream dependencies not satisfied: ${upCtx.missingDeps.join(", ")}`,
      };
    }
    if (!ctx.db.tryClaimTask(sessionId, t.task_id)) {
      return null;
    }

    // If mode was not explicitly forced to parallel_spawn, DIRECT/LIGHT tasks in a mixed turn
    // are claimed in-place rather than spawning external CLIs.
    if (!input.mode && isInPlaceTrack(t.track)) {
      const preferredHarness =
        input.harness ??
        (t.assigned_harness as HarnessId | null) ??
        (session.main_harness as HarnessId);
      const route = resolveRoute({
        role: t.role as AgentRole,
        category: t.category,
        difficulty: t.difficulty as DifficultyTier,
        harness: preferredHarness,
        model: t.assigned_model ?? undefined,
        isSubagentSpawn: true,
        mainHarness: session.main_harness as HarnessId,
        mode: "claim_only",
      });
      const effectiveModel =
        route.harness === "antigravity"
          ? normalizeAntigravityModel(route.model)
          : route.model;
      ctx.db.updateTaskStatus(sessionId, t.task_id, "running", {
        assignedHarness: null,
        assignedModel: null,
        worktreePath: null,
        subSessionId: null,
      });
      return {
        taskId: t.task_id,
        status: "running" as TaskStatus,
        harness: route.harness,
        model: effectiveModel,
        durationMs: 0,
      };
    }

    let currentAttempts = t.attempts;
    let finalResult: AsdDispatchOutput["results"][number] | null = null;

    const runtimeCaps = input.harness
      ? {
          availableHarnesses: [input.harness],
          antigravityHeadlessSupported:
            input.harness === "antigravity" || Boolean(resolveBinaryOnPath("agy")),
        }
      : !ctx.commandRunner
        ? detectLiveRuntimeCapabilities()
        : undefined;
    const routingCfg = loadRoutingConfig(ctx.projectRoot, ctx.homeDir);
    const attemptedSubIds: string[] = [];

    while (currentAttempts < 3) {
      const esc = escalateTaskRoute(
        {
          ...t,
          isSubagentSpawn: true,
          mainHarness: session.main_harness as HarnessId,
          mode: "parallel_spawn",
        } as TaskRow,
        currentAttempts,
        routingCfg,
        runtimeCaps
      );
      const route = esc.route;
      if (!route) {
        ctx.db.updateTaskStatus(sessionId, t.task_id, "failed");
        finalResult = {
          taskId: t.task_id,
          status: "failed",
          harness: (t.assigned_harness as HarnessId) ?? "opencode",
          model: t.assigned_model ?? "z-ai/glm-5.3-flash",
          durationMs: 0,
          error: "Maximum escalation attempts exhausted (failed)",
        };
        break;
      }

      ctx.db.updateTaskStatus(sessionId, t.task_id, "running", {
        assignedHarness: route.harness,
        assignedModel: route.model,
      });

      let wtInfo: TaskWorktreeInfo | null = null;
      if (t.track === "HEAVY") {
        wtInfo = createTaskWorktree(ctx.projectRoot, t.turn, t.task_id);
        ctx.db.updateTaskStatus(sessionId, t.task_id, "running", {
          worktreePath: wtInfo.wtPath,
        });
      }

      const subSessionId = `sub-${t.turn}-${t.task_id}-${t.role}-${route.harness}`;
      const prompt = buildCorePromptForTask(
        t,
        upCtx.upstreamDecisions,
        upCtx.upstreamFiles
      );

      let allowedFiles: string[] = [];
      try {
        allowedFiles = JSON.parse(t.target_files_json || "[]");
      } catch {
        allowedFiles = [];
      }

      allowedFiles = expandTaskAllowedFiles(t.role, allowedFiles);
      const workDir = wtInfo ? wtInfo.wtPath : ctx.projectRoot;
      const readSpawnOutput = (metaPath: string): string => {
        try {
          const logFile = path.join(path.dirname(metaPath), "output.log");
          return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        } catch {
          return "";
        }
      };

      const needsFallbackRetry = (res: {
        exitCode: number | null;
        timedOut?: boolean;
        metaPath: string;
      }): boolean => {
        if (res.exitCode !== 0 || res.timedOut) return true;
        const out = readSpawnOutput(res.metaPath);
        if (!isFallbackTriggerOutput(out)) return false;
        return getChangedFiles(workDir).length === 0;
      };

      const run = await runWithFallbacks({
        initialRoute: route,
        routingConfig: routingCfg,
        runtimeCapabilities: runtimeCaps,
        baseSubSessionId: subSessionId,
        allowDefaultModelRetry: !ctx.commandRunner,
        shouldRetry: needsFallbackRetry,
        attempt: async (r, sid) => {
          attemptedSubIds.push(sid);
          ctx.db.updateTaskStatus(sessionId, t.task_id, "running", {
            assignedHarness: r.harness,
            assignedModel: r.model,
            subSessionId: sid,
          });
          const cmdInfo = buildDefaultHarnessCommand(
            r.harness,
            prompt,
            r.model,
            r.thinkingEffort ?? t.thinking_effort
          );
          const effTimeoutMs =
            Number.parseInt(process.env.ASD_SPAWN_TIMEOUT_MS || "", 10) ||
            DEFAULT_DISPATCH_TIMEOUT_MS;
          const effIdleTimeoutMs =
            Number.parseInt(process.env.ASD_SPAWN_IDLE_TIMEOUT_MS || "", 10) ||
            DEFAULT_IDLE_TIMEOUT_MS;

          const firstRes = await spawnHybridSubagent({
            projectRoot: ctx.projectRoot,
            cwd: workDir,
            worktreePath: wtInfo ? wtInfo.wtPath : null,
            homeDir: ctx.homeDir,
            mainSessionId: sessionId,
            subSessionId: sid,
            role: t.role as AgentRole,
            harness: r.harness,
            model: r.model,
            thinkingEffort: r.thinkingEffort ?? t.thinking_effort,
            taskId: t.task_id,
            prompt,
            allowedFiles,
            ...(ctx.commandRunner
              ? { command: cmdInfo.command, args: cmdInfo.args }
              : {}),
            dispatchMode: "parallel_spawn",
            ownerPid: process.pid,
            commandRunner: ctx.commandRunner,
            transport: input.transport,
            acpCommandOverride: ctx.acpCommandOverride,
            timeoutMs: effTimeoutMs,
            idleTimeoutMs: effIdleTimeoutMs,
            allowSlidingTimeout: true,
            signal,
          });

          if (firstRes.acpBridgeNotice) {
            acpBridgeHintsSet.add(firstRes.acpBridgeNotice);
          }

          const maxIdleResumes = Number.parseInt(
            process.env.ASD_IDLE_RESUME_ATTEMPTS ?? "1",
            10
          );
          if (
            firstRes.timedOut &&
            firstRes.timeoutReason === "idle" &&
            firstRes.harnessSessionId &&
            !signal?.aborted &&
            maxIdleResumes > 0
          ) {
            const resumeSubId = `${sid}-idleresume-1`;
            attemptedSubIds.push(resumeSubId);
            const continuationPrompt = `Continue and complete task ${t.task_id} (${t.title}) from the current workspace state without repeating completed work, then emit the final asd-report block.`;
            const resumedRes = await spawnHybridSubagent({
              projectRoot: ctx.projectRoot,
              cwd: workDir,
              worktreePath: wtInfo ? wtInfo.wtPath : null,
              homeDir: ctx.homeDir,
              mainSessionId: sessionId,
              subSessionId: resumeSubId,
              role: t.role as AgentRole,
              harness: r.harness,
              model: r.model,
              thinkingEffort: r.thinkingEffort ?? t.thinking_effort,
              resumeSessionId: firstRes.harnessSessionId,
              harnessSessionId: firstRes.harnessSessionId,
              taskId: t.task_id,
              prompt: continuationPrompt,
              allowedFiles,
              dispatchMode: "parallel_spawn",
              ownerPid: process.pid,
              commandRunner: ctx.commandRunner,
              transport: input.transport,
              acpCommandOverride: ctx.acpCommandOverride,
              timeoutMs: effTimeoutMs,
              idleTimeoutMs: effIdleTimeoutMs,
              allowSlidingTimeout: true,
              signal,
            });
            if (resumedRes.acpBridgeNotice) {
              acpBridgeHintsSet.add(resumedRes.acpBridgeNotice);
            }
            return resumedRes;
          }

          return firstRes;
        },
      });
      const spawnResult = run.result;
      const activeRoute: ResolvedRoute = {
        ...route,
        harness: run.harness,
        model: run.model,
        modelFamily: run.modelFamily,
      };

      const rawSpawnOutput = readSpawnOutput(spawnResult.metaPath);
      const spawnLogPath = path.join(path.dirname(spawnResult.metaPath), "output.log");
      const telemetry: TaskTelemetry | undefined =
        (spawnResult as { telemetry?: TaskTelemetry }).telemetry ??
        extractTelemetryFromOutput(rawSpawnOutput, activeRoute.harness);
      if (telemetry) {
        try {
          ctx.db.recordTaskTelemetry(sessionId, t.task_id, telemetry);
        } catch {
          // Best-effort telemetry persistence
        }
      }

      const runnerFailed =
        spawnResult.exitCode !== 0 ||
        Boolean(spawnResult.timedOut) ||
        Boolean(signal?.aborted);
      if (runnerFailed) {
        if (isInPlaceTrack(t.track)) {
          const changed = getChangedFiles(ctx.projectRoot);
          const scopedFiles =
            allowedFiles.length === 0
              ? [...changed]
              : changed.filter(
                  (file) =>
                    verifyChangedFilesBoundary([file], allowedFiles, ctx.projectRoot).valid
                );
          if (scopedFiles.length > 0) {
            rollbackLightChanges(ctx.projectRoot, { files: scopedFiles });
          }
        } else if (t.track === "HEAVY" && wtInfo) {
          cleanupWorktree(ctx.projectRoot, wtInfo.wtPath, wtInfo.branchName, {
            forceBranchDelete: true,
          });
        }

        const updated = ctx.db.recordTaskAttemptFailure(sessionId, t.task_id);
        currentAttempts = updated.attempts;
        const runnerErr = signal?.aborted
          ? "Task execution aborted"
          : spawnResult.timedOut
            ? "Subagent execution timed out"
            : spawnResult.errorSummary || `Subagent exited with code ${spawnResult.exitCode}`;

        if (signal?.aborted || currentAttempts >= 3) {
          if (signal?.aborted && updated.status !== "failed") {
            ctx.db.updateTaskStatus(sessionId, t.task_id, "failed");
          }
          for (const sid of attemptedSubIds) {
            finalizeSubagentArtifacts({
              projectRoot: ctx.projectRoot,
              sessionId,
              subSessionId: sid,
            });
          }
          finalResult = {
            taskId: t.task_id,
            status: "failed",
            harness: activeRoute.harness,
            model: activeRoute.model,
            durationMs: spawnResult.durationMs,
            error: runnerErr,
            logPath: spawnResult.metaPath,
            ...(telemetry ? { telemetry } : {}),
          };
          break;
        }
        continue;
      }

      // Verification
      const effectiveAutoApprove =
        input.autoApprove !== undefined
          ? input.autoApprove
          : session.auto_approve !== 0;
      const parsedReport = parseSubagentReport(rawSpawnOutput);
      let verifyResult: {
        verified: boolean;
        commitSha?: string;
        error?: string;
        status?: TaskStatus;
        changedFiles?: string[];
      };
      if (isInPlaceTrack(t.track)) {
        verifyResult = verifyAndCommitLightTask({
          projectRoot: ctx.projectRoot,
          taskId: t.task_id,
          title: t.title,
          track: t.track as TaskTrack,
          summary: parsedReport?.summary,
          rollbackOnVerifyFailure: true,
          allowedFiles,
          verifyCmd: t.verify_cmd,
          autoApprove: effectiveAutoApprove,
          sessionId,
          db: ctx.db,
        });
      } else {
        verifyResult = await verifyAndMergeHeavyTask({
          projectRoot: ctx.projectRoot,
          turn: t.turn,
          taskId: t.task_id,
          title: t.title,
          summary: parsedReport?.summary,
          wtPath: wtInfo?.wtPath,
          branchName: wtInfo?.branchName,
          allowedFiles,
          verifyCmd: t.verify_cmd,
          autoApprove: effectiveAutoApprove,
          sessionId,
          db: ctx.db,
        });
      }

      if (verifyResult.verified) {
        if (verifyResult.status === "verifying") {
          const currentTasks = ctx.db.getSessionTasks(sessionId);
          renderPlanMd(session, currentTasks);
          finalResult = {
            taskId: t.task_id,
            status: "verifying",
            harness: activeRoute.harness,
            model: activeRoute.model,
            durationMs: spawnResult.durationMs,
            logPath: spawnLogPath,
            ...(telemetry ? { telemetry } : {}),
          };
          break;
        }
        const effectiveChangedFiles = verifyResult.changedFiles ?? allowedFiles;
        const claim: DoneClaim = {
          summary: parsedReport?.summary || `Completed task ${t.task_id}: ${t.title}`,
          changed_files: effectiveChangedFiles,
          key_decisions: [
            `Executed with @${activeRoute.harness}/${activeRoute.model}`,
            ...(parsedReport?.key_decisions ?? []),
          ],
          risks: parsedReport?.risks ?? [],
          ...(parsedReport?.cross_scope_requests &&
          parsedReport.cross_scope_requests.length > 0
            ? { cross_scope_requests: parsedReport.cross_scope_requests }
            : {}),
        };
        ctx.db.recordTaskVerified(
          sessionId,
          t.task_id,
          verifyResult.commitSha || "",
          claim,
          spawnResult.durationMs
        );
        for (const sid of attemptedSubIds) {
          finalizeSubagentArtifacts({
            projectRoot: ctx.projectRoot,
            sessionId,
            subSessionId: sid,
          });
        }

        const currentTasks = ctx.db.getSessionTasks(sessionId);
        renderPlanMd(session, currentTasks);

        finalResult = {
          taskId: t.task_id,
          status: "done",
          harness: activeRoute.harness,
          model: activeRoute.model,
          commitSha: verifyResult.commitSha,
          durationMs: spawnResult.durationMs,
          logPath: spawnResult.metaPath,
          ...(telemetry ? { telemetry } : {}),
          ...(claim.cross_scope_requests && claim.cross_scope_requests.length > 0
            ? { crossScopeRequests: claim.cross_scope_requests }
            : {}),
        };
        break;
      } else {
        const updated = ctx.db.recordTaskAttemptFailure(sessionId, t.task_id);
        currentAttempts = updated.attempts;
        if (verifyResult.status === "merge_conflict") {
          finalResult = {
            taskId: t.task_id,
            status: "merge_conflict",
            harness: activeRoute.harness,
            model: activeRoute.model,
            durationMs: spawnResult.durationMs,
            error: verifyResult.error || "Merge conflict",
            logPath: spawnLogPath,
            ...(telemetry ? { telemetry } : {}),
          };
          break;
        }
        if (currentAttempts >= 3) {
          for (const sid of attemptedSubIds) {
            finalizeSubagentArtifacts({
              projectRoot: ctx.projectRoot,
              sessionId,
              subSessionId: sid,
            });
          }
          finalResult = {
            taskId: t.task_id,
            status: "failed",
            harness: activeRoute.harness,
            model: activeRoute.model,
            durationMs: spawnResult.durationMs,
            error: verifyResult.error || "Verification failed after 3 attempts",
            logPath: spawnResult.metaPath,
            ...(telemetry ? { telemetry } : {}),
          };
          break;
        }
      }
    }

    return finalResult!;
  });

  const rawResults = await Promise.all(spawnPromises);
  const results = rawResults.filter((r): r is NonNullable<typeof r> => r !== null);

  const { autoCreatedTasks, deferredCrossScopeRequests } = processCrossScopeRequests(
    ctx.db,
    sessionId,
    selectedTurn,
    results
      .filter(
        (r) =>
          r.status === "done" &&
          Array.isArray(r.crossScopeRequests) &&
          r.crossScopeRequests.length > 0
      )
      .map((r) => ({
        taskId: r.taskId,
        requests: r.crossScopeRequests!,
      }))
  );

  const finalSessionTasks = ctx.db.getSessionTasks(sessionId);
  const allDone =
    finalSessionTasks.length > 0 && finalSessionTasks.every((t) => t.status === "done");
  if (allDone) {
    ctx.db.updateSessionPhase(sessionId, "done");
    sessionRow = ctx.db.getSession(sessionId) ?? sessionRow;
    const sessionDebates = ctx.db.getSessionDebates(sessionId);
    renderSessionSummaryMd(
      session,
      finalSessionTasks,
      sessionDebates,
      path.join(ctx.projectRoot, ".asd", "summary.md")
    );
    renderSessionSummaryMd(
      session,
      finalSessionTasks,
      sessionDebates,
      path.join(ctx.projectRoot, ".asd", "sessions", sessionId, "summary.md")
    );
  }

  renderPlanMd(session, finalSessionTasks);
  const baseBoard = renderProgressBoard(session, finalSessionTasks);
  const progressBoard = appendCrossScopeSummaryToBoard(
    baseBoard,
    autoCreatedTasks,
    deferredCrossScopeRequests
  );

  if (process.env.ASD_ASYNC_WORKER_ACTIVE === "1") {
    const existingJob = readAsyncDispatchJob(ctx.projectRoot, sessionId, ctx.homeDir);
    if (existingJob) {
      const anyFailed = results.some(
        (r) => r.status === "failed" || r.status === "merge_conflict"
      );
      const doneSummary = results
        .map(
          (r) =>
            `- ${r.taskId}: ${r.status} (@${r.harness}/${r.model})${r.error ? ` [${r.error}]` : ""}`
        )
        .join("\n");
      writeAsyncDispatchJob(
        ctx.projectRoot,
        {
          ...existingJob,
          status: anyFailed ? "failed" : "done",
          finishedAt: Date.now(),
          summary: doneSummary,
          progressBoard,
          results,
          ...(autoCreatedTasks.length > 0 ? { autoCreatedTasks } : {}),
          ...(deferredCrossScopeRequests.length > 0
            ? { deferredCrossScopeRequests }
            : {}),
        },
        ctx.homeDir
      );
    }
  }

  const acpBridgeHints = [...acpBridgeHintsSet];
  return {
    sessionId,
    turn: selectedTurn,
    dispatchedTasks: results,
    results,
    ...(autoCreatedTasks.length > 0 ? { autoCreatedTasks } : {}),
    ...(deferredCrossScopeRequests.length > 0 ? { deferredCrossScopeRequests } : {}),
    ...(acpBridgeHints.length > 0 ? { acpBridgeHints } : {}),
    progressBoard,
  };
}
