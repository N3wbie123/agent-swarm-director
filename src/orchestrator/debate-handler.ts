/**
 * ASD Orchestrator — Debate Handler (`src/orchestrator/debate-handler.ts`).
 *
 * Delegates blind cross-model adversarial review to the core debate broker.
 */

import { resolveAsdPaths } from "../core/config.ts";
import { runDebateBroker } from "../core/debate.ts";
import { getForegroundSessionId } from "../core/render.ts";
import { linkHarnessSessionToAsdSession } from "../core/session-tracker.ts";
import type { AsdDebateInput, AsdDebateOutput } from "../core/types.ts";
import type { OrchestratorContext } from "./index.ts";

export async function executeDebate(
  ctx: OrchestratorContext,
  input: AsdDebateInput,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void
): Promise<AsdDebateOutput> {
  if (ctx.isSubagent()) {
    throw new Error("Subagents cannot invoke orchestration tools");
  }
  let sessionId = input.sessionId?.trim() || "";
  if (!sessionId) {
    if (input.taskId) {
      sessionId =
        ctx.resolveImplicitSessionId({ mutating: false, action: "debate" }) ||
        `${Date.now()}-debate`;
    } else {
      const fgId = getForegroundSessionId(
        ctx.projectRoot,
        resolveAsdPaths(ctx.projectRoot, ctx.homeDir).planMdPath
      );
      const fgSession = fgId ? ctx.db.getSession(fgId) : undefined;
      sessionId =
        fgSession && fgSession.phase !== "done"
          ? fgSession.session_id
          : `${Date.now()}-debate`;
    }
  }
  linkHarnessSessionToAsdSession({
    projectRoot: ctx.projectRoot,
    homeDir: ctx.homeDir,
    asdSessionId: sessionId,
    harness: input.harness,
    db: ctx.db,
  });
  const brokerResult = await runDebateBroker({
    projectRoot: ctx.projectRoot,
    homeDir: ctx.homeDir,
    sessionId,
    taskId: input.taskId,
    topic: input.topic,
    proposal: input.proposal,
    files: input.files,
    includeDiff: input.includeDiff,
    harnesses: input.harnesses,
    roles: input.roles,
    models: input.models,
    count: input.count,
    ...(input.harness
      ? { runtimeCapabilities: { availableHarnesses: [input.harness] } }
      : {}),
    commandRunner: ctx.commandRunner,
    acpCommandOverride: ctx.acpCommandOverride,
    db: ctx.db,
    signal,
    onProgress: (msg) => {
      onProgress?.(msg);
    },
  });

  return {
    debateId: brokerResult.debateId,
    status: "done",
    verdict: brokerResult.verdict,
    hardConstraints: brokerResult.hardConstraints,
    decisions: brokerResult.decisions,
    risks: brokerResult.risks,
    diversityDegraded: brokerResult.diversityDegraded,
    updatedAcceptance: brokerResult.updatedAcceptance,
    progressBoard: brokerResult.progressBoard,
  };
}
