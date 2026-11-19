/**
 * ASD Orchestrator — Verify Handler (`src/orchestrator/verify-handler.ts`).
 *
 * Handles `asd verify` across DIRECT, LIGHT, and HEAVY tracks, surfaces
 * structured 3-Strike escalation hints on failure, caps raw test output with
 * log pointers, and processes Cross-Scope follow-up requests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRow } from "../core/db.ts";
import {
  atomicWriteFileSync,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
} from "../core/render.ts";
import { finalizeSubagentArtifacts } from "../core/spawner.ts";
import { expandTaskAllowedFiles } from "../core/subagent-control.ts";
import type {
  AsdVerifyInput,
  AsdVerifyOutput,
  AutoCreatedCrossScopeTask,
  DeferredCrossScopeRequest,
  DoneClaim,
  TaskStatus,
  TaskTrack,
} from "../core/types.ts";
import {
  isInPlaceTrack,
  verifyAndCommitLightTask,
  verifyAndMergeHeavyTask,
} from "../core/workspace.ts";
import {
  appendCrossScopeSummaryToBoard,
  processCrossScopeRequests,
} from "./dispatch-handler.ts";
import type { OrchestratorContext } from "./index.ts";

// ============================================================================
// 3-Strike Verification Failure Escalation Hints
// ============================================================================

export function buildEscalationHint(
  attempts: number,
  track: TaskTrack | string,
  taskId: string
): string {
  if (attempts <= 1) {
    return `Strike 1/3 (${taskId}, ${track}): Inspect the failing verification output and apply a targeted in-place fix, then re-run \`asd verify --task ${taskId}\`.`;
  }
  if (attempts === 2) {
    return `Strike 2/3 (${taskId}, ${track}): Raise \`thinkingEffort\` / model tier or invoke \`asd-critic\` to challenge your root-cause hypothesis before retrying \`asd verify --task ${taskId}\`.`;
  }
  return `Strike 3/3 (${taskId}, ${track}): Maximum local retries reached. Escalate to HEAVY cross-harness \`asd debate\` (or \`/asd-debug\`) with failure evidence before proceeding.`;
}

// ============================================================================
// Verify Command Handler
// ============================================================================

export async function executeVerify(
  ctx: OrchestratorContext,
  input: AsdVerifyInput
): Promise<AsdVerifyOutput> {
  const { taskId, doneClaim, verifyCmd } = input;
  const sessionId =
    input.sessionId?.trim() ||
    ctx.resolveImplicitSessionId({ mutating: false, action: "verify" }) ||
    input.sessionId;
  let sessionRow = ctx.db.getSession(sessionId);
  if (!sessionRow) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const session: SessionRow = sessionRow;
  const task = ctx.db.getTask(sessionId, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId} in session ${sessionId}`);
  }

  let allowedFiles: string[] = [];
  try {
    allowedFiles = JSON.parse(task.target_files_json || "[]");
  } catch {
    allowedFiles = [];
  }
  allowedFiles = expandTaskAllowedFiles(task.role, allowedFiles);

  let verifyResult: {
    verified: boolean;
    commitSha?: string;
    rollbackPerformed?: boolean;
    violations?: string[];
    testOutput?: string;
    testOutputTruncated?: boolean;
    testOutputLogPath?: string;
    error?: string;
    status?: TaskStatus;
  };

  const explicitSummary =
    doneClaim?.summary &&
    !/^Verified task\s+/i.test(doneClaim.summary.trim())
      ? doneClaim.summary.trim()
      : "";
  const normalizedDoneClaim: DoneClaim = {
    ...doneClaim,
    summary: explicitSummary || task.title,
  };

  const subLogPath = task.sub_session_id
    ? path.join(
        ctx.projectRoot,
        ".asd",
        "sessions",
        sessionId,
        "subagents",
        task.sub_session_id,
        "output.log"
      )
    : undefined;
  const verifyLogPath = path.join(
    ctx.projectRoot,
    ".asd",
    "sessions",
    sessionId,
    `verify-${taskId}.log`
  );

  const autoApprove = session.auto_approve !== 0;
  if (isInPlaceTrack(task.track)) {
    verifyResult = verifyAndCommitLightTask({
      projectRoot: ctx.projectRoot,
      taskId,
      title: task.title,
      track: task.track as TaskTrack,
      summary: explicitSummary || null,
      allowedFiles,
      verifyCmd: verifyCmd ?? task.verify_cmd,
      sessionId,
      db: ctx.db,
      autoApprove,
      testOutputLogPath: verifyLogPath,
    });
  } else {
    verifyResult = await verifyAndMergeHeavyTask({
      projectRoot: ctx.projectRoot,
      turn: task.turn,
      taskId,
      title: task.title,
      summary: explicitSummary || null,
      wtPath: task.worktree_path ?? undefined,
      allowedFiles,
      verifyCmd: verifyCmd ?? task.verify_cmd,
      sessionId,
      db: ctx.db,
      autoApprove,
      testOutputLogPath: verifyLogPath,
    });
  }

  let autoCreatedTasks: AutoCreatedCrossScopeTask[] = [];
  let deferredCrossScopeRequests: DeferredCrossScopeRequest[] = [];

  const isPendingApproval = verifyResult.verified && verifyResult.status === "verifying";

  if (task.sub_session_id) {
    try {
      const subDir = path.join(
        ctx.projectRoot,
        ".asd",
        "sessions",
        sessionId,
        "subagents",
        task.sub_session_id
      );
      const metaPath = path.join(subDir, "meta.json");
      const logPath = path.join(subDir, "output.log");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        const finishedAt = Date.now();
        const startedAt = typeof meta.startedAt === "number" ? meta.startedAt : finishedAt;
        if (!isPendingApproval) {
          meta.status = verifyResult.verified ? "done" : "failed";
          meta.finishedAt = finishedAt;
          meta.durationMs = Math.max(0, finishedAt - startedAt);
          atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
        }
        const logAppend = isPendingApproval
          ? `[verify:PENDING_APPROVAL] Summary: ${doneClaim?.summary || "awaiting manual approval"}\n`
          : verifyResult.verified
            ? `[verify:PASS] Commit: ${verifyResult.commitSha || "n/a"} | Summary: ${doneClaim?.summary || "completed"}\n`
            : `[verify:FAIL] ${verifyResult.error || "Verification failed"}\n`;
        fs.appendFileSync(logPath, logAppend, "utf8");
      }
    } catch {
      // Ignore subagent log update error
    }
  }

  let updatedAttempts = task.attempts;
  if (verifyResult.verified) {
    if (isPendingApproval) {
      ctx.db.updateTaskStatus(sessionId, taskId, "verifying", {
        doneClaimJson: JSON.stringify(normalizedDoneClaim),
      });
      ctx.db.resetNoProgress(sessionId);
    } else {
      ctx.db.recordTaskVerified(
        sessionId,
        taskId,
        verifyResult.commitSha || "",
        normalizedDoneClaim,
        task.duration_ms ?? 0
      );
      ctx.db.resetNoProgress(sessionId);
    }

    if (
      Array.isArray(doneClaim.cross_scope_requests) &&
      doneClaim.cross_scope_requests.length > 0
    ) {
      const crossScopeRes = processCrossScopeRequests(ctx.db, sessionId, task.turn, [
        { taskId, requests: doneClaim.cross_scope_requests },
      ]);
      autoCreatedTasks = crossScopeRes.autoCreatedTasks;
      deferredCrossScopeRequests = crossScopeRes.deferredCrossScopeRequests;
    }
  } else {
    const bumped = ctx.db.recordTaskAttemptFailure(sessionId, taskId);
    updatedAttempts = bumped.attempts;
  }

  const allTasks = ctx.db.getSessionTasks(sessionId);
  const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === "done");

  if (allDone) {
    ctx.db.updateSessionPhase(sessionId, "done");
    sessionRow = ctx.db.getSession(sessionId) ?? sessionRow;
    const sessionDebates = ctx.db.getSessionDebates(sessionId);
    renderSessionSummaryMd(
      session,
      allTasks,
      sessionDebates,
      path.join(ctx.projectRoot, ".asd", "summary.md")
    );
    renderSessionSummaryMd(
      session,
      allTasks,
      sessionDebates,
      path.join(ctx.projectRoot, ".asd", "sessions", sessionId, "summary.md")
    );
  }

  renderPlanMd(session, allTasks);
  const baseBoard = renderProgressBoard(session, allTasks);
  const progressBoard = appendCrossScopeSummaryToBoard(
    baseBoard,
    autoCreatedTasks,
    deferredCrossScopeRequests
  );

  const finalStatus: TaskStatus = isPendingApproval
    ? "verifying"
    : verifyResult.verified
      ? "done"
      : verifyResult.status ??
        (ctx.db.getTask(sessionId, taskId)?.status as TaskStatus) ??
        "failed";

  if ((finalStatus === "done" || finalStatus === "failed") && task.sub_session_id) {
    finalizeSubagentArtifacts({
      projectRoot: ctx.projectRoot,
      sessionId,
      subSessionId: task.sub_session_id,
    });
  }

  const effectiveLogPath =
    verifyResult.testOutputLogPath ??
    (subLogPath && fs.existsSync(subLogPath) ? subLogPath : undefined);
  const escalationHint = !verifyResult.verified
    ? buildEscalationHint(updatedAttempts, task.track, taskId)
    : undefined;

  return {
    verified: verifyResult.verified,
    taskId,
    status: finalStatus,
    attempts: updatedAttempts,
    commitSha: verifyResult.commitSha,
    rollbackPerformed: verifyResult.rollbackPerformed,
    violations: verifyResult.violations,
    testOutput: verifyResult.testOutput,
    ...(verifyResult.testOutputTruncated ? { testOutputTruncated: true } : {}),
    error: verifyResult.error,
    ...(escalationHint ? { escalationHint } : {}),
    ...(effectiveLogPath ? { logPath: effectiveLogPath } : {}),
    ...(autoCreatedTasks.length > 0 ? { autoCreatedTasks } : {}),
    ...(deferredCrossScopeRequests.length > 0 ? { deferredCrossScopeRequests } : {}),
    progressBoard,
  };
}
