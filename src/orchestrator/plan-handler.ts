/**
 * ASD Orchestrator — Plan Handler (`src/orchestrator/plan-handler.ts`).
 *
 * Handles `asd plan create|get|update|sync_from_md` and exports the canonical
 * `PLAN_SCHEMA_DEFINITION` (used by `asd plan schema`) plus static plan
 * validation helpers (`detectRoleCategoryWarnings`, `findOverlappingLightTargetFiles`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { syncAgentModelsIfNeeded } from "../adapters/installer.ts";
import { resolveAsdPaths } from "../core/config.ts";
import type { TaskRow } from "../core/db.ts";
import { isPathAllowed } from "../core/policy.ts";
import {
  atomicWriteFileSync,
  getForegroundSessionId,
  renderPlanMd,
  renderProgressBoard,
  syncPlanFromMd,
} from "../core/render.ts";
import {
  isValidAsdSessionId,
  linkHarnessSessionToAsdSession,
} from "../core/session-tracker.ts";
import {
  AGENT_ROLES,
  DIFFICULTY_TIERS,
  DOMAIN_CATEGORIES,
  type AgentRole,
  type AsdPlanInput,
  type AsdPlanOutput,
  type DifficultyTier,
  type HarnessId,
  type MainSessionMeta,
  type SessionPhase,
  type TaskStatus,
  type TaskTrack,
} from "../core/types.ts";
import { recoverOrphanedTasks } from "../core/workspace.ts";
import type { OrchestratorContext } from "./index.ts";

// ============================================================================
// Canonical Plan Schema (for `asd plan schema`)
// ============================================================================

export const PLAN_SCHEMA_DEFINITION = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ASD Plan Payload",
  description:
    "Canonical JSON payload accepted by `asd plan create|update --file <path.json>` or `--payload -`.",
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description: "Optional session ID (auto-generated when omitted).",
    },
    title: {
      type: "string",
      description: "Short goal/plan summary stored as session memo.",
    },
    mainHarness: {
      type: "string",
      enum: ["claude-code", "opencode", "codex", "antigravity", "cursor"],
    },
    force: {
      type: "boolean",
      description: "Force this session to take foreground .asd/PLAN.md ownership.",
    },
    autoApprove: {
      type: "boolean",
      description: "Auto-commit/merge verified tasks (default: true).",
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["taskId", "turn", "title", "targetFiles"],
        properties: {
          taskId: { type: "string", description: "Unique ID e.g. 'T1.1'" },
          turn: { type: "integer", minimum: 1, description: "Execution wave (1-based)" },
          title: { type: "string", description: "Concise imperative task summary" },
          track: {
            type: "string",
            enum: ["DIRECT", "LIGHT", "HEAVY"],
            description:
              "DIRECT: 1-3 files sequential in main session; LIGHT: single-harness internal subagents (sequential or disjoint targetFiles); HEAVY: external CLI + isolated git worktrees.",
          },
          role: {
            type: "string",
            enum: [...AGENT_ROLES],
            description:
              "5 core roles. Specialist roles (planner/architect/scout/critic) take Tier 2 precedence and ignore domain category.",
          },
          category: {
            type: "string",
            enum: [...DOMAIN_CATEGORIES],
            description:
              "Domain routing category (applied in Tier 3 only when role === 'worker').",
          },
          difficulty: {
            type: "string",
            enum: [...DIFFICULTY_TIERS],
            description: "Tier 4 difficulty routing for worker + general tasks.",
          },
          dependsOn: { type: "array", items: { type: "string" } },
          targetFiles: {
            type: "array",
            items: { type: "string" },
            description: "Allowed file paths/globs; include relevant tests/*.test.ts.",
          },
          contextHint: { type: "string" },
          acceptance: { type: "string" },
          verifyCmd: { type: "string" },
        },
      },
    },
  },
  required: ["tasks"],
  routingNotes: [
    "Domain categories (visual-ui, design, research, writing) activate Tier 3 routing ONLY when role === 'worker'.",
    "Same-turn LIGHT tasks should either run sequentially or declare strictly disjoint targetFiles.",
  ],
} as const;

// ============================================================================
// Validation & Formatting Helpers
// ============================================================================

export function formatTaskForOutput(t: TaskRow) {
  let dependsOn: string[] = [];
  try {
    dependsOn = JSON.parse(t.depends_on_json || "[]");
  } catch {
    dependsOn = [];
  }

  let targetFiles: string[] = [];
  try {
    targetFiles = JSON.parse(t.target_files_json || "[]");
  } catch {
    targetFiles = [];
  }

  return {
    taskId: t.task_id,
    task_id: t.task_id,
    turn: t.turn,
    title: t.title,
    track: t.track as TaskTrack,
    role: t.role as AgentRole,
    category: t.category,
    difficulty: t.difficulty as DifficultyTier,
    status: t.status as TaskStatus,
    assignedHarness: (t.assigned_harness as HarnessId) ?? undefined,
    assignedModel: t.assigned_model ?? undefined,
    dependsOn,
    targetFiles,
    contextHint: t.context_hint ?? undefined,
    acceptance: t.acceptance ?? undefined,
    verifyCmd: t.verify_cmd ?? undefined,
  };
}

function normalizeTrack(raw?: string): TaskTrack | undefined {
  if (!raw) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === "DIRECT" || upper === "LIGHT" || upper === "HEAVY") {
    return upper;
  }
  return undefined;
}

function normalizePathPattern(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function patternsOverlap(a: string, b: string): boolean {
  const pa = normalizePathPattern(a);
  const pb = normalizePathPattern(b);
  if (!pa || !pb) return false;
  if (pa.toLowerCase() === pb.toLowerCase()) return true;
  if (isPathAllowed(pa, [pb]) || isPathAllowed(pb, [pa])) return true;
  return false;
}

/**
 * Detects specialist tasks (role !== "worker") that also specify a non-general
 * domain category, warning that Tier 2 specialist routing takes precedence.
 */
export function detectRoleCategoryWarnings(
  tasks: Array<{ taskId: string; role?: string; category?: string }>
): string[] {
  const warnings: string[] = [];
  for (const t of tasks) {
    const role = (t.role || "worker").trim().toLowerCase();
    const category = (t.category || "general").trim().toLowerCase();
    if (role !== "worker" && category !== "general") {
      warnings.push(
        `Task ${t.taskId}: specialist role '${role}' takes Tier 2 precedence over category '${category}' (category is ignored for non-worker roles; use role='worker' if you intend Tier 3 domain routing).`
      );
    }
  }
  return warnings;
}

/**
 * Detects overlapping `targetFiles` between multiple `LIGHT` tasks in the same turn.
 */
export function findOverlappingLightTargetFiles(
  tasks: Array<{ taskId: string; turn: number; track?: string; targetFiles: string[] }>
): string[] {
  const warnings: string[] = [];
  const byTurn = new Map<number, Array<{ taskId: string; targetFiles: string[] }>>();

  for (const t of tasks) {
    if ((t.track ?? "LIGHT").toUpperCase() !== "LIGHT") continue;
    const list = byTurn.get(t.turn) ?? [];
    list.push({ taskId: t.taskId, targetFiles: t.targetFiles });
    byTurn.set(t.turn, list);
  }

  for (const [turn, group] of byTurn.entries()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const left = group[i]!;
        const right = group[j]!;
        const overlapping = new Set<string>();
        for (const lf of left.targetFiles) {
          for (const rf of right.targetFiles) {
            if (patternsOverlap(lf, rf)) {
              overlapping.add(normalizePathPattern(lf));
            }
          }
        }
        if (overlapping.size > 0) {
          warnings.push(
            `Turn ${turn} LIGHT tasks ${left.taskId} and ${right.taskId} share overlapping targetFiles (${[...overlapping].join(", ")}); run them sequentially or split into disjoint targetFiles (or use HEAVY worktrees).`
          );
        }
      }
    }
  }

  return warnings;
}

// ============================================================================
// Plan Command Handler
// ============================================================================

export async function executePlan(
  ctx: OrchestratorContext,
  input: AsdPlanInput
): Promise<AsdPlanOutput> {
  if (ctx.isSubagent()) {
    throw new Error("Subagents cannot invoke orchestration tools");
  }
  const action = input.action;
  const paths = resolveAsdPaths(ctx.projectRoot, ctx.homeDir);
  let sessionId = input.sessionId?.trim() || "";

  if (!sessionId) {
    const mutating =
      action === "create" || action === "update" || action === "sync_from_md";
    sessionId = ctx.resolveImplicitSessionId({ mutating, action }) ?? "";
  } else if (!isValidAsdSessionId(sessionId)) {
    throw new Error("INVALID_SESSION_ID");
  }

  if (action === "get") {
    const sessionRow = sessionId ? ctx.db.getSession(sessionId) : undefined;
    if (!sessionRow) {
      return {
        sessionId,
        stateVersion: 0,
        phase: "planning",
        tasks: [],
        planMdPath: paths.planMdPath,
        foreground: false,
        progressBoard: renderProgressBoard(null, []),
      };
    }
    try {
      recoverOrphanedTasks({
        db: ctx.db,
        projectRoot: ctx.projectRoot,
        sessionId: sessionRow.session_id,
      });
    } catch {
      // best-effort orphan recovery on read
    }
    const taskRows = ctx.db.getSessionTasks(sessionRow.session_id);
    const currentFgId = getForegroundSessionId(ctx.projectRoot, paths.planMdPath);
    const foreground = !currentFgId || currentFgId === sessionRow.session_id;
    const progressBoard = renderProgressBoard(sessionRow, taskRows);
    return {
      sessionId: sessionRow.session_id,
      stateVersion: sessionRow.state_version,
      phase: sessionRow.phase as SessionPhase,
      tasks: taskRows.map(formatTaskForOutput),
      planMdPath: paths.planMdPath,
      foreground,
      progressBoard,
    };
  }

  // Refresh agent markdown model definitions if routing.jsonc changed
  syncAgentModelsIfNeeded({ homeDir: ctx.homeDir, projectRoot: ctx.projectRoot });

  // Ensure session exists
  let sessionRow = ctx.db.getSession(sessionId);
  if (!sessionRow) {
    sessionRow = ctx.db.createOrGetSession({
      sessionId,
      projectRoot: ctx.projectRoot,
      mainHarness: input.mainHarness || "claude-code",
      mainPid: process.pid,
      mainModel: input.mainModel ?? null,
      harnessSessionId: input.harnessSessionId ?? null,
      autoApprove: input.autoApprove,
    });
  }

  const warnings: string[] = [];

  if (action === "create" || action === "update") {
    if (input.tasks && input.tasks.length > 0) {
      const defaultTrack = normalizeTrack(input.track);
      const normalizedTasks = input.tasks.map((rawTask, idx) => {
        const t = rawTask as typeof rawTask & {
          id?: string;
          agent?: AgentRole;
          allowedFiles?: string[];
          verificationCmd?: string;
        };
        const turn =
          typeof t.turn === "number" && Number.isFinite(t.turn) && t.turn >= 1
            ? t.turn
            : 1;
        let taskId = String(t.taskId || t.id || `T${turn}.${idx + 1}`).trim();
        const dashMatch = taskId.match(/^T-(\d+)$/i);
        if (dashMatch) {
          taskId = `T${turn}.${dashMatch[1]}`;
        } else if (!/^T(?:-)?\d+(?:\.\d+|-\d+)?$/i.test(taskId)) {
          taskId = `T${turn}.${idx + 1}`;
        }
        return {
          taskId,
          turn,
          title: t.title,
          track: normalizeTrack(t.track) ?? defaultTrack,
          role: (t.role || t.agent) as AgentRole | undefined,
          category: t.category,
          difficulty: t.difficulty,
          dependsOn: t.dependsOn,
          targetFiles: t.targetFiles || t.allowedFiles || [],
          contextHint: t.contextHint,
          acceptance: t.acceptance,
          verifyCmd: t.verifyCmd ?? t.verificationCmd,
        };
      });

      warnings.push(...detectRoleCategoryWarnings(normalizedTasks));
      ctx.db.upsertTasks(sessionId, normalizedTasks);

      const autoMemo = (
        (input as { title?: string }).title ||
        input.tasks[0]?.title ||
        ""
      )
        .trim()
        .slice(0, 40);
      if (autoMemo && !sessionRow.memo) {
        ctx.db.updateSessionMemo(sessionId, autoMemo);
        sessionRow = ctx.db.getSession(sessionId) ?? sessionRow;
      }
    }
  } else if (action === "sync_from_md") {
    syncPlanFromMd(ctx.db, sessionId, paths.planMdPath);
    sessionRow = ctx.db.getSession(sessionId) ?? sessionRow;
  }

  // Write <projectRoot>/.asd/sessions/<sessionId>/main.json
  const sessionDir = path.join(ctx.projectRoot, ".asd", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const mainMeta: MainSessionMeta = {
    sessionId,
    roleType: "main",
    harness: (sessionRow.main_harness as HarnessId) || "claude-code",
    role: "director",
    phase: sessionRow.phase as SessionPhase,
    pid: sessionRow.main_pid ?? process.pid,
    startedAt: new Date(sessionRow.created_at).toISOString(),
    ...(sessionRow.main_model ? { model: sessionRow.main_model } : {}),
    ...(sessionRow.harness_session_id
      ? { harnessSessionId: sessionRow.harness_session_id }
      : {}),
    autoApprove: sessionRow.auto_approve !== 0,
    ...(sessionRow.memo ? { memo: sessionRow.memo } : {}),
  };
  atomicWriteFileSync(
    path.join(sessionDir, "main.json"),
    JSON.stringify(mainMeta, null, 2) + "\n"
  );

  // CR-04: Attach/switch CLI driver on create/update unless called by GUI driver or subagent
  if (
    (action === "create" || action === "update") &&
    ctx.sessionRole !== "driver" &&
    process.env.ASD_SESSION_ROLE !== "driver" &&
    !ctx.isSubagent()
  ) {
    linkHarnessSessionToAsdSession({
      projectRoot: ctx.projectRoot,
      homeDir: ctx.homeDir,
      asdSessionId: sessionId,
      harness: (input.mainHarness || sessionRow.main_harness) as HarnessId,
      ...(input.harnessSessionId !== undefined
        ? { harnessSessionId: input.harnessSessionId }
        : {}),
      mainModel: input.mainModel ?? sessionRow.main_model ?? null,
      autoApprove: input.autoApprove,
      source: "cli-asd",
      db: ctx.db,
    });
  }
  sessionRow = ctx.db.getSession(sessionId) ?? sessionRow;
  const taskRows = ctx.db.getSessionTasks(sessionId);

  // Detect same-turn LIGHT overlapping targetFiles across full session plan
  const formattedTasks = taskRows.map(formatTaskForOutput);
  warnings.push(
    ...findOverlappingLightTargetFiles(
      formattedTasks.map((t) => ({
        taskId: t.taskId,
        turn: t.turn,
        track: t.track,
        targetFiles: t.targetFiles,
      }))
    )
  );

  // Renders .asd/PLAN.md (only take foreground on create if no active non-done foreground session exists)
  const existingFgId = getForegroundSessionId(ctx.projectRoot, paths.planMdPath);
  let forceForeground = false;
  if (Boolean(input.force)) {
    forceForeground = true;
  } else if (action === "create" || action === "update") {
    if (!existingFgId || existingFgId === sessionId) {
      forceForeground = true;
    } else {
      const existingFgSession = ctx.db.getSession(existingFgId);
      if (!existingFgSession || existingFgSession.phase === "done") {
        forceForeground = true;
      }
    }
  }
  renderPlanMd(sessionRow, taskRows, paths.planMdPath, { force: forceForeground });
  const currentFgId = getForegroundSessionId(ctx.projectRoot, paths.planMdPath);
  const foreground = !currentFgId || currentFgId === sessionId;

  const progressBoard = renderProgressBoard(sessionRow, taskRows);

  return {
    sessionId,
    stateVersion: sessionRow.state_version,
    phase: sessionRow.phase as SessionPhase,
    tasks: formattedTasks,
    planMdPath: paths.planMdPath,
    foreground,
    progressBoard,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
