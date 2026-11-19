/**
 * ASD Core Orchestrator (`src/orchestrator/index.ts`).
 *
 * In-process command controller for `asd plan`, `asd dispatch`, `asd verify`,
 * and `asd debate`. Replaces the retired `src/mcp/` server with focused
 * domain handlers (`plan-handler`, `dispatch-handler`, `verify-handler`,
 * `debate-handler`).
 *
 * Invariants:
 * - Erasable TypeScript only: NO enum, type-only imports where applicable.
 * - Zero external runtime npm dependencies.
 */

import * as path from "node:path";
import {
  autoSyncIfNeeded,
  runAsdDoctor,
  syncAgentModelsIfNeeded,
} from "../adapters/installer.ts";
import { resolveAsdPaths } from "../core/config.ts";
import { openProjectDb, type SqliteDriver, type TaskRow } from "../core/db.ts";
import { getForegroundSessionId } from "../core/render.ts";
import { buildPromptForTask as buildCorePromptForTask } from "../core/session-services.ts";
import { generateAsdSessionId } from "../core/session-tracker.ts";
import type { CommandRunner } from "../core/spawner.ts";
import {
  registerCoreInstallerHooks,
  type AsdDebateInput,
  type AsdDebateOutput,
  type AsdDispatchInput,
  type AsdDispatchOutput,
  type AsdPlanInput,
  type AsdPlanOutput,
  type AsdVerifyInput,
  type AsdVerifyOutput,
} from "../core/types.ts";
import { executeDebate } from "./debate-handler.ts";
import {
  MAX_AUTO_CROSS_SCOPE_PER_TASK,
  MAX_CROSS_SCOPE_CHAIN_DEPTH,
  appendCrossScopeSummaryToBoard,
  executeDispatch,
  parseSubagentReport,
  processCrossScopeRequests,
  type ParsedSubagentReport,
} from "./dispatch-handler.ts";
import {
  PLAN_SCHEMA_DEFINITION,
  detectRoleCategoryWarnings,
  executePlan,
  findOverlappingLightTargetFiles,
  formatTaskForOutput,
} from "./plan-handler.ts";
import { buildEscalationHint, executeVerify } from "./verify-handler.ts";

registerCoreInstallerHooks({ runAsdDoctor, syncAgentModelsIfNeeded });

export {
  MAX_AUTO_CROSS_SCOPE_PER_TASK,
  MAX_CROSS_SCOPE_CHAIN_DEPTH,
  PLAN_SCHEMA_DEFINITION,
  appendCrossScopeSummaryToBoard,
  buildEscalationHint,
  detectRoleCategoryWarnings,
  findOverlappingLightTargetFiles,
  formatTaskForOutput,
  parseSubagentReport,
  processCrossScopeRequests,
  type ParsedSubagentReport,
};

export function buildPromptForTask(
  task: TaskRow,
  upstreamDecisions: string[],
  upstreamFiles: string[]
): string {
  return buildCorePromptForTask(task, upstreamDecisions, upstreamFiles);
}

// ============================================================================
// Orchestrator Configuration & Internal Context
// ============================================================================

export interface AsdOrchestratorOptions {
  projectRoot?: string;
  homeDir?: string;
  commandRunner?: CommandRunner;
  acpCommandOverride?: { command: string; args: string[] };
  sessionRole?: string;
  autoSync?: boolean;
  onMainStart?: () => Promise<void> | void;
  db?: SqliteDriver;
}

export interface OrchestratorContext {
  readonly projectRoot: string;
  readonly homeDir?: string;
  readonly commandRunner?: CommandRunner;
  readonly acpCommandOverride?: { command: string; args: string[] };
  readonly sessionRole: string;
  readonly db: SqliteDriver;
  isSubagent(): boolean;
  resolveImplicitSessionId(options?: {
    mutating?: boolean;
    action?: string;
  }): string | undefined;
  createBackgroundOrchestrator(): AsdOrchestrator;
}

// ============================================================================
// AsdOrchestrator Class
// ============================================================================

export class AsdOrchestrator {
  private readonly projectRoot: string;
  private readonly homeDir?: string;
  private readonly commandRunner?: CommandRunner;
  private readonly acpCommandOverride?: { command: string; args: string[] };
  private readonly sessionRole: string;
  private readonly db: SqliteDriver;
  private readonly ownsDb: boolean;

  constructor(options?: AsdOrchestratorOptions) {
    this.projectRoot = path.resolve(options?.projectRoot || process.cwd());
    this.homeDir = options?.homeDir;
    this.commandRunner = options?.commandRunner;
    this.acpCommandOverride = options?.acpCommandOverride;
    this.sessionRole = options?.sessionRole ?? process.env.ASD_SESSION_ROLE ?? "main";

    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = openProjectDb(this.projectRoot, this.homeDir);
      this.ownsDb = true;
    }

    if (this.sessionRole !== "subagent") {
      if (options?.onMainStart) {
        void Promise.resolve(options.onMainStart()).catch(() => {});
      } else if (options?.autoSync === true) {
        void autoSyncIfNeeded({
          homeDir: this.homeDir,
          projectRoot: this.projectRoot,
        }).catch(() => {});
      }
    }
  }

  close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {
        // already closed
      }
    }
  }

  private isSubagent(): boolean {
    return (
      this.sessionRole === "subagent" || process.env.ASD_SESSION_ROLE === "subagent"
    );
  }

  private resolveImplicitSessionId(options?: {
    mutating?: boolean;
    action?: string;
  }): string | undefined {
    const paths = resolveAsdPaths(this.projectRoot, this.homeDir);
    const fgId = getForegroundSessionId(this.projectRoot, paths.planMdPath);
    const fgSession = fgId ? this.db.getSession(fgId) : undefined;
    const latest = this.db.getLatestSession();
    const mutating = options?.mutating ?? false;

    if (fgSession && fgSession.phase !== "done") {
      return fgSession.session_id;
    }

    if (mutating) {
      if (latest && latest.phase !== "done") {
        return latest.session_id;
      }
      return generateAsdSessionId();
    }

    if (fgSession) {
      return fgSession.session_id;
    }

    return latest?.session_id;
  }

  private createContext(): OrchestratorContext {
    return {
      projectRoot: this.projectRoot,
      homeDir: this.homeDir,
      commandRunner: this.commandRunner,
      acpCommandOverride: this.acpCommandOverride,
      sessionRole: this.sessionRole,
      db: this.db,
      isSubagent: () => this.isSubagent(),
      resolveImplicitSessionId: (opts) => this.resolveImplicitSessionId(opts),
      createBackgroundOrchestrator: () =>
        new AsdOrchestrator({
          projectRoot: this.projectRoot,
          homeDir: this.homeDir,
          commandRunner: this.commandRunner,
          acpCommandOverride: this.acpCommandOverride,
          autoSync: false,
        }),
    };
  }

  async handlePlan(input: AsdPlanInput): Promise<AsdPlanOutput> {
    return executePlan(this.createContext(), input);
  }

  async handleDispatch(
    input: AsdDispatchInput,
    signal?: AbortSignal,
    dispatchOpts?: { detachAsyncWorker?: boolean }
  ): Promise<AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] }> {
    return executeDispatch(this.createContext(), input, signal, dispatchOpts);
  }

  async handleVerify(input: AsdVerifyInput): Promise<AsdVerifyOutput> {
    return executeVerify(this.createContext(), input);
  }

  async handleDebate(
    input: AsdDebateInput,
    signal?: AbortSignal,
    onProgress?: (msg: string) => void
  ): Promise<AsdDebateOutput> {
    return executeDebate(this.createContext(), input, signal, onProgress);
  }
}

// ============================================================================
// Standalone Convenience Functions
// ============================================================================

export async function handlePlan(
  input: AsdPlanInput,
  options?: AsdOrchestratorOptions
): Promise<AsdPlanOutput> {
  const orch = new AsdOrchestrator({ autoSync: false, ...options });
  try {
    return await orch.handlePlan(input);
  } finally {
    orch.close();
  }
}

export async function handleDispatch(
  input: AsdDispatchInput,
  options?: AsdOrchestratorOptions & { signal?: AbortSignal }
): Promise<Awaited<ReturnType<AsdOrchestrator["handleDispatch"]>>> {
  const orch = new AsdOrchestrator({ autoSync: false, ...options });
  try {
    return await orch.handleDispatch(input, options?.signal);
  } finally {
    orch.close();
  }
}

export async function handleVerify(
  input: AsdVerifyInput,
  options?: AsdOrchestratorOptions
): Promise<AsdVerifyOutput> {
  const orch = new AsdOrchestrator({ autoSync: false, ...options });
  try {
    return await orch.handleVerify(input);
  } finally {
    orch.close();
  }
}

export async function handleDebate(
  input: AsdDebateInput,
  options?: AsdOrchestratorOptions & {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  }
): Promise<AsdDebateOutput> {
  const orch = new AsdOrchestrator({ autoSync: false, ...options });
  try {
    return await orch.handleDebate(input, options?.signal, options?.onProgress);
  } finally {
    orch.close();
  }
}
