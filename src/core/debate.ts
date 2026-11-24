/**
 * ASD v2.7.0 Core Broker Blind Debate Engine (src/core/debate.ts).
 *
 * Implements:
 * 1. Zero-polling parallel blind cross-model debate.
 * 2. Cross-model diverse reviewer selection via `selectDiverseReviewer` (router.ts).
 * 3. Round 1 (Blind Openings): parallel subagent spawn via Promise.allSettled with
 *    physical isolation (independent subagent sessions, zero visibility into peer openings).
 * 4. Graceful recovery when 1 reviewer times out or crashes as long as at least 1 valid opening survives.
 * 5. Structured verdict parsing (APPROVE | MINOR_AMEND | REJECT, hard_constraints, decisions, risks).
 * 6. Early Exit: if all surviving openings are APPROVE or MINOR_AMEND, synthesizes InsightVerdict
 *    immediately without Round 2.
 * 7. Round 2 (Conflict Resolution & Arbiter Verdict): if any reviewer returns REJECT, runs
 *    rebuttal/arbiter pass with collected Round 1 bundle to produce final InsightVerdict.
 * 8. SQLite persistence in `debates` table (status = 'done') and automatic injection into
 *    `tasks.acceptance` and atomic `.asd/PLAN.md` update when taskId is provided.
 *
 * Invariants:
 * - Zero imports from `src/adapters/*` (core engine purity).
 * - Zero external runtime npm dependencies.
 * - TypeScript erasableSyntaxOnly: true (no enum, type-only imports where applicable).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { executeAcpSubagentTurn, probeAcpCapability } from "./acp-client.ts";
import { loadRoutingConfig, resolveAsdPaths } from "./config.ts";
import { openProjectDb } from "./db.ts";
import type { SqliteDriver, SessionRow, TaskRow } from "./db.ts";
import { checkProtectedPath, resolveSafeTargetPath } from "./policy.ts";
import { redactSecrets } from "./redact.ts";
import { renderPlanMd, renderProgressBoard } from "./render.ts";
import {
  buildHeadlessHarnessCommand,
  buildSpawnSpec,
  isValidAsdSessionId,
} from "./session-tracker.ts";
import {
  detectLiveRuntimeCapabilities,
  inferModelFamily,
  normalizeAgentRole,
  resolveLightSubagentRoute,
  runWithFallbacks,
  selectDiverseReviewer,
} from "./router.ts";
import type {
  DiverseReviewerSelection,
  ProposalRouteInput,
  RuntimeCapabilities,
} from "./router.ts";
import {
  DEFAULT_DEBATE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  finalizeSubagentArtifacts,
  spawnSubagent,
} from "./spawner.ts";
import type {
  CommandRunner,
  SpawnSubagentOptions,
  SpawnSubagentResult,
} from "./spawner.ts";
import type {
  AgentRole,
  AsdDebateOutput,
  HarnessId,
  RoutingConfig,
  SubagentSessionMeta,
  SubagentTransportMode,
} from "./types.ts";
import { runGit } from "./workspace.ts";

// ============================================================================
// Types & Contracts
// ============================================================================

export type DebateVerdict = "APPROVE" | "MINOR_AMEND" | "REJECT";

export interface ParsedOpening {
  verdict: DebateVerdict;
  hard_constraints: string[];
  decisions: string[];
  risks: string[];
  reasoning: string;
}

export interface ReviewerSpec {
  role: AgentRole;
  harness: HarnessId;
  model: string;
  modelFamily: string;
  diversityDegraded: boolean;
  fallbacks?: Array<{
    harness: HarnessId;
    model: string;
    modelFamily: string;
  }>;
}

export interface ReviewerOpening {
  reviewerId: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  modelFamily: string;
  verdict: DebateVerdict;
  hard_constraints: string[];
  decisions: string[];
  risks: string[];
  reasoning: string;
  rawOutput?: string;
  durationMs?: number;
}

export interface FailedReviewer {
  reviewerId: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  error: string;
}

export interface Round1Bundle {
  openings: ReviewerOpening[];
  failedReviewers: FailedReviewer[];
}

export interface Round2Bundle {
  arbiterVerdict: ReviewerOpening;
  round1Reference: Round1Bundle;
}

export interface InsightVerdict {
  verdict: DebateVerdict;
  hard_constraints: string[];
  decisions: string[];
  risks: string[];
  diversity_degraded?: boolean;
  reasoning?: string;
}

export interface RunDebateBrokerOptions {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  taskId?: string | null;
  topic: string;
  proposal: string;
  files?: string[];
  includeDiff?: boolean;
  debateId?: string;
  proposerRoute?: ProposalRouteInput;
  routingConfig?: RoutingConfig;
  runtimeCapabilities?: RuntimeCapabilities;
  harnesses?: HarnessId[];
  roles?: AgentRole[];
  models?: string[];
  count?: number;
  reviewerRoles?: AgentRole[];
  reviewerRoutes?: Array<{
    harness: HarnessId;
    model: string;
    modelFamily?: string;
    role?: AgentRole;
  }>;
  arbiterRoute?: {
    harness: HarnessId;
    model: string;
    modelFamily?: string;
    role?: AgentRole;
  };
  commandRunner?: CommandRunner;
  commandBuilder?: (
    harness: HarnessId,
    prompt: string,
    model: string
  ) => { command: string; args: string[] };
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  db?: SqliteDriver;
  transport?: SubagentTransportMode;
  acpCommandOverride?: { command: string; args: string[] };
}

export interface DebateBrokerResult extends AsdDebateOutput {
  sessionId: string;
  taskId?: string | null;
  topic: string;
  round1Bundle: Round1Bundle;
  round2Bundle: Round2Bundle | null;
  insightVerdict: InsightVerdict;
}

// ============================================================================
// Helper: Default Command Builder (Harness-Purity Compliant)
// ============================================================================

/**
 * Builds standard headless execution commands for the supported harnesses
 * without requiring any import from src/adapters/*.
 * Delegates to the canonical core builder in session-tracker.ts; an unknown
 * harness id falls back to a no-op node echo that approves instantly.
 */
export function buildDefaultHarnessCommand(
  harness: HarnessId,
  prompt: string,
  model: string,
  thinkingEffort?: string | null
): { command: string; args: string[] } {
  return (
    buildHeadlessHarnessCommand({ harness, prompt, model, thinkingEffort }) ?? {
      command: "node",
      args: [
        "-e",
        `console.log(JSON.stringify({ verdict: "APPROVE", hard_constraints: [], decisions: [], risks: [] }))`,
      ],
    }
  );
}

export interface SpawnHybridSubagentOptions
  extends Omit<SpawnSubagentOptions, "command" | "args"> {
  command?: string;
  args?: string[];
  thinkingEffort?: string | null;
  resumeSessionId?: string | null;
  transport?: SubagentTransportMode;
  acpCommandOverride?: { command: string; args: string[] };
}

export interface SpawnHybridSubagentResult extends SpawnSubagentResult {
  transportUsed: "acp" | "cli";
  errorSummary?: string;
  acpBridgeNotice?: string;
}

/**
 * Hybrid subagent runner (ACP-first with seamless hardened streaming CLI fallback):
 * 1. When a mock `commandRunner` is injected (unit tests), preserves deterministic CLI mock path.
 * 2. When `transport` is `"auto"` (default) or `"acp"`, runs via `executeAcpSubagentTurn` whenever
 *    the harness supports ACP natively (`opencode`, `antigravity`, `cursor`) or has an ACP bridge installed.
 * 3. Falls back automatically to `buildSpawnSpec({ streaming: true })` CLI execution when ACP bridges
 *    are not installed (e.g., `claude-code` / `codex` without global ACP adapters) or `transport === "cli"`.
 */
export async function spawnHybridSubagent(
  options: SpawnHybridSubagentOptions
): Promise<SpawnHybridSubagentResult> {
  if (!isValidAsdSessionId(options.mainSessionId)) {
    throw new Error("INVALID_SESSION_ID");
  }

  const effectiveTransport: SubagentTransportMode =
    options.transport ??
    (process.env.ASD_TRANSPORT === "acp" ||
    process.env.ASD_TRANSPORT === "cli" ||
    process.env.ASD_TRANSPORT === "auto"
      ? process.env.ASD_TRANSPORT
      : "auto");

  // 1. Deterministic mock CommandRunner path (preserves 100% existing unit test contracts)
  if (options.commandRunner) {
    const fallbackCmd =
      options.command !== undefined && options.args !== undefined
        ? { command: options.command, args: options.args }
        : buildDefaultHarnessCommand(
            options.harness,
            options.prompt,
            options.model === "default" ? "" : options.model,
            options.thinkingEffort
          );
    const res = await spawnSubagent({
      ...options,
      command: fallbackCmd.command,
      args: fallbackCmd.args,
    });
    return { ...res, transportUsed: "cli" };
  }

  // 2. ACP-first execution path
  let pendingAcpBridgeNotice: string | undefined;
  if (effectiveTransport !== "cli") {
    const readiness = options.acpCommandOverride
      ? {
          supported: true,
          command: options.acpCommandOverride.command,
          args: options.acpCommandOverride.args,
          installHint: undefined,
        }
      : probeAcpCapability(options.harness, process.env);

    if (readiness.supported || effectiveTransport === "acp") {
      const paths = resolveAsdPaths(options.projectRoot, options.homeDir);
      const sessionDir = path.join(
        paths.sessionsDir,
        options.mainSessionId,
        "subagents",
        options.subSessionId
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      const metaPath = path.join(sessionDir, "meta.json");
      const logPath = path.join(sessionDir, "output.log");
      fs.writeFileSync(path.join(sessionDir, "prompt.md"), redactSecrets(options.prompt));

      const startedAt = Date.now();
      let meta: SubagentSessionMeta = {
        subSessionId: options.subSessionId,
        parentSessionId: options.mainSessionId,
        roleType: "subagent",
        role: options.role,
        harness: options.harness,
        model: options.model,
        harnessSessionId: options.resumeSessionId ?? options.harnessSessionId ?? null,
        transport: "acp",
        taskId: options.taskId,
        pid: 0,
        ownerPid: options.ownerPid ?? process.pid,
        dispatchMode: options.dispatchMode ?? "parallel_spawn",
        worktreePath: options.worktreePath ?? null,
        allowedFiles: options.allowedFiles,
        status: "running",
        startedAt,
      };
      const writeMeta = (): void => {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      };
      writeMeta();

      if (!readiness.supported) {
        const hintSuffix = readiness.installHint
          ? ` Install ACP bridge via: ${readiness.installHint}`
          : "";
        const errText = `[ACP_MISSING_BRIDGE] ACP adapter not installed for '${options.harness}'.${hintSuffix}\n`;
        fs.appendFileSync(logPath, errText, "utf8");
        const finishedAt = Date.now();
        meta = {
          ...meta,
          exitCode: -1,
          status: "failed",
          finishedAt,
          durationMs: finishedAt - startedAt,
          errorSummary: errText.trim(),
        };
        writeMeta();
        return {
          exitCode: -1,
          durationMs: finishedAt - startedAt,
          metaPath,
          harnessSessionId: meta.harnessSessionId,
          timedOut: false,
          transportUsed: "acp",
          errorSummary: errText.trim(),
        };
      }

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        NODE_NO_WARNINGS: "1",
        ASD_MAIN_SESSION_ID: options.mainSessionId,
        ASD_SESSION_ROLE: "subagent",
        ASD_SUBAGENT_META: metaPath,
      };

      const acpRes = await executeAcpSubagentTurn({
        harness: options.harness,
        role: options.role,
        model: options.model,
        thinkingEffort: options.thinkingEffort,
        prompt: options.prompt,
        cwd: options.cwd ?? options.projectRoot,
        allowedFiles: options.allowedFiles,
        metaPath,
        logPath,
        resumeSessionId: options.resumeSessionId ?? options.harnessSessionId,
        commandOverride: options.acpCommandOverride,
        env,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxDurationMs: options.maxDurationMs,
        idleTimeoutMs: options.idleTimeoutMs,
        allowSlidingTimeout: options.allowSlidingTimeout ?? true,
        onSpawn: (pid) => {
          meta = { ...meta, pid };
          writeMeta();
        },
        onSessionIdDetected: (sid) => {
          meta = { ...meta, harnessSessionId: sid };
          writeMeta();
        },
      });

      const finishedAt = Date.now();
      meta = {
        ...meta,
        pid: acpRes.pid,
        exitCode: acpRes.exitCode,
        harnessSessionId: acpRes.sessionId,
        status: acpRes.status,
        finishedAt,
        durationMs: acpRes.durationMs,
        errorSummary: acpRes.errorSummary,
      };
      writeMeta();

      return {
        exitCode: acpRes.exitCode,
        durationMs: acpRes.durationMs,
        metaPath,
        harnessSessionId: acpRes.sessionId,
        timedOut: acpRes.timedOut,
        ...(acpRes.timeoutReason ? { timeoutReason: acpRes.timeoutReason } : {}),
        ...(acpRes.errorSummary ? { errorSummary: acpRes.errorSummary } : {}),
        transportUsed: "acp",
      };
    } else if (readiness.installHint) {
      pendingAcpBridgeNotice = `${options.harness}: ACP bridge not found (executed via streaming CLI fallback). Optional setup: ${readiness.installHint}`;
    }
  }

  // 3. Hardened Streaming CLI Fallback (`buildSpawnSpec` with `streaming: true`)
  const cliSpec =
    options.command !== undefined && options.args !== undefined
      ? {
          command: options.command,
          args: options.args,
          stdinPayload: options.stdinPayload,
          closeStdinOnSpawn: options.closeStdinOnSpawn ?? true,
          promptFilePath: options.promptFilePath,
        }
      : buildSpawnSpec({
          harness: options.harness,
          prompt: options.prompt,
          model: options.model,
          thinkingEffort: options.thinkingEffort,
          streaming: true,
          resumeSessionId:
            options.resumeSessionId ?? options.harnessSessionId ?? undefined,
        });

  const cliRes = await spawnSubagent({
    ...options,
    command: cliSpec.command,
    args: cliSpec.args,
    stdinPayload: cliSpec.stdinPayload,
    closeStdinOnSpawn: cliSpec.closeStdinOnSpawn ?? true,
    promptFilePath: cliSpec.promptFilePath,
    allowSlidingTimeout: options.allowSlidingTimeout ?? true,
  });

  return {
    ...cliRes,
    transportUsed: "cli",
    ...(pendingAcpBridgeNotice ? { acpBridgeNotice: pendingAcpBridgeNotice } : {}),
  };
}

// ============================================================================
// Helper: String Deduplication & Acceptance Formatting
// ============================================================================

export function deduplicateStrings(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  if (typeof val === "string" && val.trim().length > 0) return [val.trim()];
  return [];
}

/**
 * Folds reviewer openings into a single InsightVerdict:
 * REJECT > MINOR_AMEND > APPROVE, with deduplicated constraint/decision/risk unions.
 */
export function synthesizeInsightVerdict(
  openings: Array<{
    verdict?: unknown;
    hard_constraints?: unknown;
    decisions?: unknown;
    risks?: unknown;
    role?: unknown;
    harness?: unknown;
    model?: unknown;
    reasoning?: unknown;
  }>,
  diversityDegraded = false
): InsightVerdict {
  const verdicts = openings.map((o) => String(o.verdict ?? "APPROVE"));
  return {
    verdict: verdicts.includes("REJECT")
      ? "REJECT"
      : verdicts.includes("MINOR_AMEND")
        ? "MINOR_AMEND"
        : "APPROVE",
    hard_constraints: deduplicateStrings(
      openings.flatMap((o) => toStringArray(o.hard_constraints))
    ),
    decisions: deduplicateStrings(openings.flatMap((o) => toStringArray(o.decisions))),
    risks: deduplicateStrings(openings.flatMap((o) => toStringArray(o.risks))),
    diversity_degraded: diversityDegraded,
    reasoning: openings
      .map(
        (o) =>
          `${o.role ?? "reviewer"} (@${o.harness ?? "unknown"}/${o.model ?? "default"}): ${
            typeof o.reasoning === "string" && o.reasoning ? o.reasoning : o.verdict
          }`
      )
      .join("; "),
  };
}

function extractLogErrorSnippet(metaPath: string): string {
  try {
    const logPath = path.join(path.dirname(metaPath), "output.log");
    if (!fs.existsSync(logPath)) return "";
    const content = fs.readFileSync(logPath, "utf8").trim();
    if (!content) return "";
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    return lastLine.length > 200 ? `${lastLine.slice(0, 200)}...` : lastLine;
  } catch {
    return "";
  }
}

export function formatDebateAcceptance(
  debateId: string,
  hardConstraints: string[],
  decisions: string[]
): string {
  const parts: string[] = [];
  if (decisions.length > 0) {
    parts.push(`[Debate ${debateId}] Decisions: ${decisions.join("; ")}`);
  }
  if (hardConstraints.length > 0) {
    parts.push(
      `[Debate ${debateId}] Hard Constraints: ${hardConstraints.join("; ")}`
    );
  }
  return parts.join("\n\n");
}

// ============================================================================
// Structured Verdict JSON Parser
// ============================================================================

function tryParseJsonObject(raw: string): ParsedOpening | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;

    const rawVerdict = String(obj.verdict ?? "").toUpperCase().trim();
    if (
      rawVerdict !== "APPROVE" &&
      rawVerdict !== "MINOR_AMEND" &&
      rawVerdict !== "REJECT"
    ) {
      return null;
    }

    const hardConstraints = toStringArray(
      obj.hard_constraints ?? obj.hardConstraints
    );
    const decisions = toStringArray(obj.decisions);
    const risks = toStringArray(obj.risks);
    const reasoning = String(obj.reasoning ?? obj.reason ?? "").trim();

    return {
      verdict: rawVerdict as DebateVerdict,
      hard_constraints: deduplicateStrings(hardConstraints),
      decisions: deduplicateStrings(decisions),
      risks: deduplicateStrings(risks),
      reasoning,
    };
  } catch {
    return null;
  }
}

function parseDirectText(rawText: string): ParsedOpening | null {
  // 1. Look for markdown code fence
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      const parsed = tryParseJsonObject(candidate);
      if (parsed) return parsed;
    }
  }

  // 2. Direct JSON parse
  const direct = tryParseJsonObject(rawText.trim());
  if (direct) return direct;

  // 3. Outermost brace search
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = rawText.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJsonObject(candidate);
    if (parsed) return parsed;
  }

  return null;
}

interface ExtractedEnvelopeText {
  deltas: string[];
  messages: string[];
}

function extractTextFromJsonEnvelope(
  obj: Record<string, unknown>
): ExtractedEnvelopeText {
  const deltas: string[] = [];
  const messages: string[] = [];

  // 1. Streaming text delta fragments (must be joined with "" to avoid breaking split JSON tokens)
  if (obj.step_update && typeof obj.step_update === "object") {
    const su = obj.step_update as Record<string, unknown>;
    if (typeof su.text_delta === "string" && su.text_delta) {
      deltas.push(su.text_delta);
    }
  }
  if (obj.delta && typeof obj.delta === "object") {
    const d = obj.delta as Record<string, unknown>;
    if (typeof d.text === "string" && d.text && d.type !== "thinking_delta") {
      deltas.push(d.text);
    }
  }
  if (obj.properties && typeof obj.properties === "object") {
    const props = obj.properties as Record<string, unknown>;
    if (typeof props.delta === "string" && props.delta) {
      deltas.push(props.delta);
    }
  }

  // 2. Complete message / summary envelope fields (skip user prompt echoes and thinking blocks)
  if (typeof obj.text === "string" && obj.text.trim()) messages.push(obj.text);
  if (typeof obj.result === "string" && obj.result.trim()) messages.push(obj.result);
  if (obj.result && typeof obj.result === "object") {
    const resRec = obj.result as Record<string, unknown>;
    if (typeof resRec.response === "string" && resRec.response.trim()) {
      messages.push(resRec.response);
    }
  }
  if (typeof obj.response === "string" && obj.response.trim()) messages.push(obj.response);
  if (typeof obj.content === "string" && obj.content.trim()) messages.push(obj.content);
  if (typeof obj.message === "string" && obj.message.trim()) messages.push(obj.message);
  if (obj.message && typeof obj.message === "object") {
    const msgRec = obj.message as Record<string, unknown>;
    if (msgRec.role !== "user" && Array.isArray(msgRec.content)) {
      for (const b of msgRec.content) {
        if (
          b &&
          typeof b === "object" &&
          (b as Record<string, unknown>).type !== "thinking" &&
          typeof (b as Record<string, unknown>).text === "string"
        ) {
          messages.push(String((b as Record<string, unknown>).text));
        }
      }
    }
  }
  if (obj.part && typeof obj.part === "object") {
    const part = obj.part as Record<string, unknown>;
    if (typeof part.text === "string" && part.text.trim()) messages.push(part.text);
  }
  if (obj.item && typeof obj.item === "object") {
    const item = obj.item as Record<string, unknown>;
    if (typeof item.text === "string" && item.text.trim()) messages.push(item.text);
  }
  if (obj.msg && typeof obj.msg === "object") {
    const msg = obj.msg as Record<string, unknown>;
    if (typeof msg.message === "string" && msg.message.trim()) messages.push(msg.message);
  }

  return { deltas, messages };
}

/**
 * Extracts structured verdict from subagent output:
 * 0. Unwraps JSON / NDJSON CLI envelopes (OpenCode `part.text`, Claude `result`, Codex `item.text`, Antigravity `response` / `step_update.text_delta`)
 * 1. Markdown ```json code fences
 * 2. Entire raw text as JSON
 * 3. Embedded JSON object spanning from first '{' to last '}'
 */
export function parseReviewerOpening(rawText: string): ParsedOpening | null {
  if (!rawText || typeof rawText !== "string") return null;

  const directParsed = parseDirectText(rawText);
  if (directParsed) return directParsed;

  // Unwrap NDJSON lines or JSON envelope objects emitted by CLI harnesses (--format json / --output-format json)
  const deltaChunks: string[] = [];
  const messageChunks: string[] = [];
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const envObj = JSON.parse(trimmed) as Record<string, unknown>;
      if (envObj && typeof envObj === "object") {
        const directLine = tryParseJsonObject(trimmed);
        if (directLine) return directLine;
        const { deltas, messages } = extractTextFromJsonEnvelope(envObj);
        for (const msg of messages) {
          const parsedMsg = parseDirectText(msg);
          if (parsedMsg) return parsedMsg;
          messageChunks.push(msg);
        }
        for (const delta of deltas) {
          deltaChunks.push(delta);
        }
      }
    } catch {
      // ignore non-JSON line
    }
  }

  // Prefer streaming delta buffer joined without newlines to preserve mid-token JSON splits
  if (deltaChunks.length > 0) {
    const parsedDeltas = parseDirectText(deltaChunks.join(""));
    if (parsedDeltas) return parsedDeltas;
  }

  // Fallback to complete message chunks kept separate from delta stream (prevents double-concatenation)
  if (messageChunks.length > 0) {
    const parsedMessages = parseDirectText(messageChunks.join("\n"));
    if (parsedMessages) return parsedMessages;
    const parsedMessagesCompact = parseDirectText(messageChunks.join(""));
    if (parsedMessagesCompact) return parsedMessagesCompact;
  }

  return null;
}

// ============================================================================
// Prompts & Ground-Truth Code Context Builder (Method 1 + Method 3)
// ============================================================================

const MAX_DIFF_LINES = 200;
const MAX_R2_CITATION_SNIPPETS = 5;
const R2_CITATION_RADIUS_LINES = 15;
const MAX_R2_CITATION_CHARS = 6_000;

interface LoadedFileRange {
  relPath: string;
  startLine: number;
  endLine: number;
}

function parseFileSliceSpec(spec: string): {
  rawFilePath: string;
  startLine: number;
  endLine: number;
} {
  const match = spec.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
  const rawFilePath = (match?.[1] ?? spec).trim();
  const startLine = match?.[2] ? Math.max(1, Number.parseInt(match[2], 10)) : 1;
  const endLine = match?.[3]
    ? Math.max(startLine, Number.parseInt(match[3], 10))
    : match?.[2]
      ? startLine + 149
      : 150;
  return { rawFilePath, startLine, endLine };
}

/**
 * Reads target file slices (`path[:start-end]`) and/or `git diff HEAD` directly
 * in Node.js (zero Main Agent LLM tokens) and formats numbered source lines
 * for cross-examination by debate reviewers.
 */
export function buildDebateCodeContext(
  projectRoot: string,
  files?: string[],
  includeDiff?: boolean
): string {
  const sections: string[] = [];
  const rootAbs = path.resolve(projectRoot);

  if (files && files.length > 0) {
    for (const rawSpec of files) {
      const spec = rawSpec.trim();
      if (!spec) continue;

      const { rawFilePath, startLine, endLine } = parseFileSliceSpec(spec);

      // Prevent path traversal, symlink escape, and reading protected/secret files
      const safeTarget = resolveSafeTargetPath(rawFilePath, rootAbs);
      if (!safeTarget.safe || !safeTarget.relativeToRoot) continue;
      const relPath = safeTarget.relativeToRoot;
      if (checkProtectedPath(relPath).protected) continue;
      const absPath = safeTarget.resolvedPath;

      if (!fs.existsSync(absPath)) {
        sections.push(`### File: ${relPath} (Not found)`);
        continue;
      }

      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(absPath, "utf8");
        const allLines = content.split(/\r?\n/);
        const clampedStart = Math.min(startLine, Math.max(1, allLines.length));
        const clampedEnd = Math.min(endLine, allLines.length);
        const sliced = allLines.slice(clampedStart - 1, clampedEnd);
        const numbered = sliced
          .map((line, idx) => `${clampedStart + idx}: ${redactSecrets(line)}`)
          .join("\n");
        const truncatedNotice =
          clampedStart > 1 || clampedEnd < allLines.length
            ? `\n[... Truncated: showing lines ${clampedStart}-${clampedEnd} of ${allLines.length} ...]`
            : "";

        sections.push(
          `### File: ${relPath} (Lines ${clampedStart}-${clampedEnd} of ${allLines.length})\n` +
            `\`\`\`\n${numbered}\n\`\`\`${truncatedNotice}`
        );
      } catch {
        // Ignore unreadable files
      }
    }
  }

  if (includeDiff) {
    try {
      const statRes = runGit(["diff", "--stat", "HEAD"], { cwd: rootAbs });
      if (statRes.exitCode === 0 && statRes.stdout.trim()) {
        sections.push(
          `### Git Diff Stat (HEAD)\n\`\`\`\n${redactSecrets(statRes.stdout.trim())}\n\`\`\``
        );
      }
      const diffRes = runGit(["diff", "HEAD"], { cwd: rootAbs });
      if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
        const allDiffLines = diffRes.stdout.trim().split(/\r?\n/);
        const diffLines = allDiffLines.slice(0, MAX_DIFF_LINES);
        const redactedDiff = redactSecrets(diffLines.join("\n"));
        const diffTruncNotice =
          allDiffLines.length > MAX_DIFF_LINES
            ? `\n[... Truncated: showing lines 1-${MAX_DIFF_LINES} of ${allDiffLines.length} ...]`
            : "";
        sections.push(
          `### Git Diff (HEAD)\n\`\`\`diff\n${redactedDiff}\n\`\`\`${diffTruncNotice}`
        );
      }
    } catch {
      // Ignore git diff failures
    }
  }

  return sections.join("\n\n");
}

/**
 * Extracts `file:line` citations from Round 1 openings and loads bounded,
 * policy-verified surrounding source slices not already present in Round 1 context.
 */
export function buildRound2CitedCodeContext(
  projectRoot: string,
  round1: Round1Bundle,
  initialFiles?: string[]
): string {
  const rootAbs = path.resolve(projectRoot);
  const loadedRanges: LoadedFileRange[] = [];

  for (const rawSpec of initialFiles ?? []) {
    const spec = rawSpec.trim();
    if (!spec) continue;
    const { rawFilePath, startLine, endLine } = parseFileSliceSpec(spec);
    const safeTarget = resolveSafeTargetPath(rawFilePath, rootAbs);
    if (safeTarget.safe && safeTarget.relativeToRoot) {
      loadedRanges.push({
        relPath: safeTarget.relativeToRoot,
        startLine,
        endLine,
      });
    }
  }

  const corpus = round1.openings
    .flatMap((o) => [o.reasoning, ...o.hard_constraints, ...o.decisions, ...o.risks])
    .filter(Boolean)
    .join("\n");

  // Match relative file paths with extensions followed by :line or :start-end (avoids HH:MM and drive letters)
  const citationRegex =
    /(?<![A-Za-z0-9_:/\\.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?\b/g;

  const snippets: string[] = [];
  let totalChars = 0;
  let match: RegExpExecArray | null;

  while (
    (match = citationRegex.exec(corpus)) !== null &&
    snippets.length < MAX_R2_CITATION_SNIPPETS &&
    totalChars < MAX_R2_CITATION_CHARS
  ) {
    const rawCandidate = match[1]!.trim();
    const citedStart = Math.max(1, Number.parseInt(match[2]!, 10));
    const citedEnd = match[3]
      ? Math.max(citedStart, Number.parseInt(match[3], 10))
      : citedStart;

    const safeTarget = resolveSafeTargetPath(rawCandidate, rootAbs);
    if (!safeTarget.safe || !safeTarget.relativeToRoot) continue;
    const relPath = safeTarget.relativeToRoot;
    if (checkProtectedPath(relPath).protected) continue;

    // Skip if already covered by Round 1 context or an earlier expanded snippet
    const alreadyCovered = loadedRanges.some(
      (r) =>
        r.relPath === relPath &&
        citedStart >= r.startLine &&
        citedEnd <= r.endLine
    );
    if (alreadyCovered) continue;

    try {
      if (!fs.existsSync(safeTarget.resolvedPath)) continue;
      const stat = fs.statSync(safeTarget.resolvedPath);
      if (!stat.isFile()) continue;

      const allLines = fs
        .readFileSync(safeTarget.resolvedPath, "utf8")
        .split(/\r?\n/);
      if (allLines.length === 0 || citedStart > allLines.length) continue;

      const winStart = Math.max(1, citedStart - R2_CITATION_RADIUS_LINES);
      const winEnd = Math.min(
        allLines.length,
        Math.min(citedEnd, citedStart + R2_CITATION_RADIUS_LINES) +
          R2_CITATION_RADIUS_LINES
      );

      const numbered = allLines
        .slice(winStart - 1, winEnd)
        .map((line, idx) => `${winStart + idx}: ${redactSecrets(line)}`)
        .join("\n");
      const block =
        `### Cited File: ${relPath} (Lines ${winStart}-${winEnd} of ${allLines.length}, cited :${citedStart})\n` +
        `\`\`\`\n${numbered}\n\`\`\``;

      if (totalChars + block.length > MAX_R2_CITATION_CHARS) continue;
      snippets.push(block);
      totalChars += block.length;
      loadedRanges.push({ relPath, startLine: winStart, endLine: winEnd });
    } catch {
      // Ignore unreadable cited file
    }
  }

  return snippets.join("\n\n");
}

const DEBATE_ROLE_LENSES: Record<AgentRole, string> = {
  critic:
    "Focus on adversarial falsification: security boundaries, path traversal/secret leaks, race conditions, error/fallback handling, silent data corruption, and edge cases where the proposal contradicts actual code.",
  architect:
    "Focus on system architecture and invariants: module coupling, core purity (zero adapter imports, zero external runtime dependencies), type/API contracts, backward compatibility, and long-term maintainability.",
  planner:
    "Focus on execution planning and scope discipline: task decomposition, rollback/recovery safety, verifiable acceptance criteria, YAGNI/over-engineering risks, and wave/dependency ordering.",
  worker:
    "Focus on implementation feasibility: concrete code-level edge cases, deterministic unit testability, cross-platform/OS behavior, and runtime failure modes.",
  scout:
    "Focus on codebase consistency: cross-file call-site impacts, hidden references, existing test expectations, and documentation/contract drift.",
};

export function buildRound1Prompt(
  topic: string,
  proposal: string,
  taskId?: string | null,
  codeContext?: string,
  role?: AgentRole
): string {
  const canonicalRole = role ? normalizeAgentRole(role) ?? role : undefined;
  const lines: string[] = [
    `# ASD Debate Round 1: Blind Review`,
    `Topic: ${topic}`,
    `Task ID: ${taskId ?? "N/A"}`,
    ...(canonicalRole ? [`Reviewer Role: ${canonicalRole}`] : []),
    ``,
    `## Proposal`,
    proposal,
    ``,
  ];

  if (codeContext && codeContext.trim()) {
    lines.push(`## Ground-Truth Source Code`, codeContext.trim(), ``);
  }

  if (canonicalRole && DEBATE_ROLE_LENSES[canonicalRole]) {
    lines.push(
      `## Role-Specific Review Lens (${canonicalRole})`,
      DEBATE_ROLE_LENSES[canonicalRole],
      ``
    );
  }

  lines.push(
    `## Instructions`,
    `You are an adversarial, independent reviewer evaluating this architectural or implementation proposal.`,
    `1. Treat the proposal as an UNVERIFIED hypothesis. Do NOT rubber-stamp or agree out of sycophancy.`,
    `2. Cross-examine every claim in the proposal against the Ground-Truth Source Code (if provided above). If the actual code contradicts the proposal, reveals a false positive, or shows the change is unnecessary/over-engineered, return REJECT or MINOR_AMEND.`,
    `3. Cite concrete evidence (e.g., \`file:line\` references or specific code behavior) in your \`reasoning\`, \`hard_constraints\`, and \`risks\`.`,
    `IMPORTANT: Do NOT call any tools, do NOT read files, and do NOT execute shell commands. Evaluate the proposal based solely on the context provided above and respond immediately.`,
    ``,
    `You MUST return your judgment strictly as a JSON block with this schema:`,
    `\`\`\`json`,
    `{`,
    `  "verdict": "APPROVE" | "MINOR_AMEND" | "REJECT",`,
    `  "hard_constraints": ["Constraint 1", "Constraint 2"],`,
    `  "decisions": ["Decision 1", "Decision 2"],`,
    `  "risks": ["Risk 1", "Risk 2"],`,
    `  "reasoning": "Detailed explanation citing file:line evidence where applicable"`,
    `}`,
    `\`\`\``
  );

  return lines.join("\n");
}

export function buildRound2Prompt(
  topic: string,
  proposal: string,
  round1: Round1Bundle,
  taskId?: string | null,
  codeContext?: string
): string {
  const openingsText = round1.openings
    .map(
      (o) =>
        `### Reviewer [${o.role} | @${o.harness}/${o.model}]\n` +
        `Verdict: ${o.verdict}\n` +
        `Reasoning: ${o.reasoning || "None"}\n` +
        `Decisions:\n${
          o.decisions.length > 0
            ? o.decisions.map((d) => `- ${d}`).join("\n")
            : "- None"
        }\n` +
        `Hard Constraints:\n${
          o.hard_constraints.length > 0
            ? o.hard_constraints.map((c) => `- ${c}`).join("\n")
            : "- None"
        }\n` +
        `Risks:\n${
          o.risks.length > 0
            ? o.risks.map((r) => `- ${r}`).join("\n")
            : "- None"
        }`
    )
    .join("\n\n");

  const lines: string[] = [
    `# ASD Debate Round 2: Conflict Resolution & Arbiter Judgment`,
    `Topic: ${topic}`,
    `Task ID: ${taskId ?? "N/A"}`,
    ``,
    `## Original Proposal`,
    proposal,
    ``,
  ];

  if (codeContext && codeContext.trim()) {
    lines.push(`## Ground-Truth Source Code`, codeContext.trim(), ``);
  }

  lines.push(
    `## Round 1 Openings & Disagreements`,
    openingsText,
    ``,
    `## Arbiter Instructions`,
    `At least one reviewer rejected the proposal or raised critical conflicts during Round 1.`,
    `As the final Arbiter, cross-examine both the Original Proposal and Round 1 reviewer claims against the Ground-Truth Source Code (if provided) and resolve the conflicts.`,
    `Produce the definitive binding verdict and list of hard constraints and decisions, citing concrete \`file:line\` evidence where applicable.`,
    `IMPORTANT: Round 1 \`hard_constraints\` and \`decisions\` are NOT automatically inherited. Explicitly include every valid Round 1 constraint and decision you choose to uphold in your final JSON arrays; any Round 1 item you omit will be discarded.`,
    `IMPORTANT: Do NOT call any tools, do NOT read files, and do NOT execute shell commands. Evaluate based solely on the context provided above and respond immediately.`,
    ``,
    `You MUST return your final judgment strictly as a JSON block with this schema:`,
    `\`\`\`json`,
    `{`,
    `  "verdict": "APPROVE" | "MINOR_AMEND" | "REJECT",`,
    `  "hard_constraints": ["Constraint 1", "Constraint 2"],`,
    `  "decisions": ["Decision 1", "Decision 2"],`,
    `  "risks": ["Risk 1", "Risk 2"],`,
    `  "reasoning": "Synthesis and final resolution"`,
    `}`,
    `\`\`\``
  );

  return lines.join("\n");
}

// ============================================================================
// Core Debate Broker
// ============================================================================

const DEFAULT_DEBATE_ROLE_CYCLE: readonly AgentRole[] = [
  "critic",
  "architect",
  "planner",
  "worker",
  "scout",
];

const DEFAULT_HARNESS_DEBATE_MODELS: Record<HarnessId, string> = {
  "claude-code": "claude-opus-5-5",
  opencode: "z-ai/glm-5.3-flash",
  codex: "gpt-6-luna",
  antigravity: "gemini-4-carbon-high",
  cursor: "claude-sonnet-5-5-high",
};

/**
 * Resolves the best HEAVY/external CLI debate model and fallbacks configured for a specific
 * `(harness, role)` pair in `routing.jsonc`.
 */
export function resolveHarnessDebateModel(
  harness: HarnessId,
  role: AgentRole,
  routingConfig?: RoutingConfig,
  occurrenceIndex = 0
): {
  model: string;
  modelFamily: string;
  fallbacks: Array<{ harness: HarnessId; model: string; modelFamily: string }>;
} {
  const agentsMap = routingConfig?.heavyRouting?.agents ?? routingConfig?.agents;
  const categoriesMap =
    routingConfig?.heavyRouting?.categories ?? routingConfig?.categories;

  const matchedModels: string[] = [];
  const crossFallbacks: Array<{
    harness: HarnessId;
    model: string;
    modelFamily: string;
  }> = [];

  const collectFromEntry = (
    entry?: {
      harness?: HarnessId;
      model?: string;
      modelFamily?: string;
      fallbacks?: Array<{ harness: HarnessId; model: string; modelFamily?: string }>;
    }
  ) => {
    if (!entry) return;
    const all = [
      ...(entry.harness && entry.model
        ? [{ harness: entry.harness, model: entry.model, modelFamily: entry.modelFamily }]
        : []),
      ...(entry.fallbacks ?? []),
    ];
    for (const c of all) {
      if (!c.model || !c.model.trim()) continue;
      const m = c.model.trim();
      if (c.harness === harness) {
        if (!matchedModels.includes(m)) matchedModels.push(m);
      } else if (
        c.harness &&
        !crossFallbacks.some((f) => f.harness === c.harness && f.model === m)
      ) {
        crossFallbacks.push({
          harness: c.harness,
          model: m,
          modelFamily: c.modelFamily ?? inferModelFamily(m, c.harness),
        });
      }
    }
  };

  // 1. Role-specific entry in agents table
  const canonicalRole = normalizeAgentRole(role);
  collectFromEntry((canonicalRole ? agentsMap?.[canonicalRole] : undefined) ?? agentsMap?.[role]);

  // 2. Other roles in agents table + high/medium/general categories
  for (const r of DEFAULT_DEBATE_ROLE_CYCLE) {
    if (r !== canonicalRole) collectFromEntry(agentsMap?.[r]);
  }
  for (const catKey of ["high", "medium", "general", "research"]) {
    collectFromEntry(categoriesMap?.[catKey]);
  }

  // 3. Fallback to lightSubagents (for non-enum models or when agents table has no match)
  if (matchedModels.length === 0) {
    const lightRoute = resolveLightSubagentRoute(harness, canonicalRole, routingConfig);
    if (lightRoute && harness !== "antigravity") {
      matchedModels.push(lightRoute.model);
      for (const fb of lightRoute.fallbacks) {
        if (!matchedModels.includes(fb.model)) matchedModels.push(fb.model);
      }
    }
  }

  const chosenModel =
    matchedModels[occurrenceIndex] ??
    matchedModels[0] ??
    DEFAULT_HARNESS_DEBATE_MODELS[harness] ??
    "default";
  const sameHarnessFallbacks = matchedModels
    .filter((m) => m !== chosenModel)
    .map((m) => ({
      harness,
      model: m,
      modelFamily: inferModelFamily(m, harness),
    }));

  return {
    model: chosenModel,
    modelFamily: inferModelFamily(chosenModel, harness),
    fallbacks: [...sameHarnessFallbacks, ...crossFallbacks],
  };
}

/**
 * Resolves the Round 1 reviewer list for `runDebateBroker` based on:
 * 1. Explicit `reviewerRoutes` or `models` (`[role@]harness[:model]`)
 * 2. Explicit `harnesses` (`--harnesses h1,h2,...`) + optional `count` / `roles`
 * 3. Explicit `roles` (`--roles r1,r2,...`) or `count` (`--count N`) from `routing.jsonc`
 * 4. Default 2-reviewer diverse selection (`critic`, `architect`)
 */
export function resolveDebateReviewers(options: {
  proposerRoute?: ProposalRouteInput;
  routingConfig?: RoutingConfig;
  runtimeCapabilities?: RuntimeCapabilities;
  harnesses?: HarnessId[];
  roles?: AgentRole[];
  models?: string[];
  count?: number;
  reviewerRoles?: AgentRole[];
  reviewerRoutes?: RunDebateBrokerOptions["reviewerRoutes"];
  hasMockRunner?: boolean;
}): { reviewers: ReviewerSpec[]; diversityDegraded: boolean } {
  const reviewers: ReviewerSpec[] = [];
  let diversityDegraded = false;
  const effectiveRoutingConfig = options.routingConfig;
  const effectiveCapabilities = options.runtimeCapabilities;
  const explicitRoles = options.roles ?? options.reviewerRoles;

  // 1. Explicit reviewerRoutes
  if (options.reviewerRoutes && options.reviewerRoutes.length > 0) {
    for (const route of options.reviewerRoutes) {
      const family =
        route.modelFamily ?? inferModelFamily(route.model, route.harness);
      reviewers.push({
        role: route.role ?? "critic",
        harness: route.harness,
        model: route.model,
        modelFamily: family,
        diversityDegraded: false,
      });
    }
    const families = new Set(reviewers.map((r) => r.modelFamily));
    if (reviewers.length > 1 && families.size === 1) diversityDegraded = true;
    return { reviewers, diversityDegraded };
  }

  // 2. Explicit models specs (e.g. ["opencode:glm-5", "codex:gpt-5-codex"] or ["critic@opencode:glm-5"])
  if (options.models && options.models.length > 0) {
    const harnessCounts = new Map<HarnessId, number>();
    for (let i = 0; i < options.models.length; i++) {
      const rawSpec = options.models[i]!.trim();
      if (!rawSpec) continue;
      let role: AgentRole =
        explicitRoles?.[i] ??
        DEFAULT_DEBATE_ROLE_CYCLE[i % DEFAULT_DEBATE_ROLE_CYCLE.length]!;
      let remainder = rawSpec;
      if (remainder.includes("@")) {
        const atIdx = remainder.indexOf("@");
        const rolePart = remainder.slice(0, atIdx).trim();
        if (rolePart) role = normalizeAgentRole(rolePart) ?? role;
        remainder = remainder.slice(atIdx + 1).trim();
      }
      const sepIdx = remainder.indexOf(":");
      const harness = (
        sepIdx >= 0 ? remainder.slice(0, sepIdx).trim() : remainder
      ) as HarnessId;
      const explicitModel =
        sepIdx >= 0 ? remainder.slice(sepIdx + 1).trim() : "";
      const occ = harnessCounts.get(harness) ?? 0;
      harnessCounts.set(harness, occ + 1);
      const resolved = resolveHarnessDebateModel(
        harness,
        role,
        effectiveRoutingConfig,
        occ
      );
      const model = explicitModel || resolved.model;
      reviewers.push({
        role,
        harness,
        model,
        modelFamily: inferModelFamily(model, harness),
        diversityDegraded: false,
        fallbacks: resolved.fallbacks,
      });
    }
    if (reviewers.length > 0) {
      const families = new Set(reviewers.map((r) => r.modelFamily));
      if (reviewers.length > 1 && families.size === 1) diversityDegraded = true;
      return { reviewers, diversityDegraded };
    }
  }

  // 3. Explicit harnesses list (e.g. --harnesses opencode,codex,claude-code)
  if (options.harnesses && options.harnesses.length > 0) {
    const cleanHarnesses = options.harnesses.filter(Boolean);
    const targetCount =
      options.count && Number.isFinite(options.count) && options.count > 0
        ? Math.min(Math.max(1, Math.trunc(options.count)), 10)
        : cleanHarnesses.length;

    const expandedHarnesses: HarnessId[] = [];
    for (let i = 0; i < targetCount; i++) {
      expandedHarnesses.push(cleanHarnesses[i % cleanHarnesses.length]!);
    }

    const harnessCounts = new Map<HarnessId, number>();
    for (let i = 0; i < expandedHarnesses.length; i++) {
      const harness = expandedHarnesses[i]!;
      const role: AgentRole =
        explicitRoles?.[i] ??
        DEFAULT_DEBATE_ROLE_CYCLE[i % DEFAULT_DEBATE_ROLE_CYCLE.length]!;
      const occ = harnessCounts.get(harness) ?? 0;
      harnessCounts.set(harness, occ + 1);
      const resolved = resolveHarnessDebateModel(
        harness,
        role,
        effectiveRoutingConfig,
        occ
      );
      reviewers.push({
        role,
        harness,
        model: resolved.model,
        modelFamily: resolved.modelFamily,
        diversityDegraded: false,
        fallbacks: resolved.fallbacks,
      });
    }
    const families = new Set(reviewers.map((r) => r.modelFamily));
    if (reviewers.length > 1 && families.size === 1) diversityDegraded = true;
    return { reviewers, diversityDegraded };
  }

  // 4. Role-based / Count-based / Auto-assigned selection from routing.jsonc
  const proposerRoute: ProposalRouteInput = options.proposerRoute ?? {
    harness: "claude-code",
    model: "claude-opus-5-5",
    modelFamily: "claude",
  };

  let targetRoles: AgentRole[];
  if (explicitRoles && explicitRoles.length > 0) {
    targetRoles = [...explicitRoles];
    if (options.count && options.count > targetRoles.length) {
      const clamped = Math.min(Math.trunc(options.count), 10);
      while (targetRoles.length < clamped) {
        targetRoles.push(
          DEFAULT_DEBATE_ROLE_CYCLE[
            targetRoles.length % DEFAULT_DEBATE_ROLE_CYCLE.length
          ]!
        );
      }
    } else if (options.count && options.count > 0 && options.count < targetRoles.length) {
      targetRoles = targetRoles.slice(0, Math.trunc(options.count));
    }
  } else if (options.count && Number.isFinite(options.count) && options.count > 0) {
    const clamped = Math.min(Math.max(1, Math.trunc(options.count)), 10);
    targetRoles = [];
    for (let i = 0; i < clamped; i++) {
      targetRoles.push(
        DEFAULT_DEBATE_ROLE_CYCLE[i % DEFAULT_DEBATE_ROLE_CYCLE.length]!
      );
    }
  } else {
    targetRoles = ["critic", "architect"];
  }

  const isExplicitRoleOrCountSelection =
    Boolean(options.roles && options.roles.length > 0) ||
    Boolean(options.count && options.count > 0);
  const agentsMap =
    effectiveRoutingConfig?.heavyRouting?.agents ??
    effectiveRoutingConfig?.agents;
  const usedPairs = new Set<string>();
  const proposerFamily =
    proposerRoute.modelFamily ||
    inferModelFamily(
      proposerRoute.model || "",
      proposerRoute.harness as HarnessId | undefined
    );
  const excludedFamilies: string[] = proposerFamily ? [proposerFamily] : [];

  for (let i = 0; i < targetRoles.length; i++) {
    const role = targetRoles[i]!;
    const canonicalRole = normalizeAgentRole(role);

    // If user explicitly requested roles from routing.jsonc (e.g. --roles critic,architect,worker),
    // try the role's configured route/fallbacks in routing.jsonc first (preferring unused harness:model pairs)
    if (isExplicitRoleOrCountSelection && canonicalRole && agentsMap?.[canonicalRole]) {
      const entry = agentsMap[canonicalRole]!;
      const candidates = [
        {
          harness: entry.harness,
          model: entry.model,
          modelFamily:
            entry.modelFamily ?? inferModelFamily(entry.model, entry.harness),
        },
        ...((entry.fallbacks as Array<{ harness: HarnessId; model: string; modelFamily?: string }>) ?? []).map((fb) => ({
          harness: fb.harness,
          model: fb.model,
          modelFamily:
            fb.modelFamily ?? inferModelFamily(fb.model, fb.harness),
        })),
      ].filter((c) => {
        if (!c.harness || !c.model) return false;
        if (
          effectiveCapabilities?.availableHarnesses &&
          effectiveCapabilities.availableHarnesses.length > 0 &&
          !effectiveCapabilities.availableHarnesses.includes(c.harness)
        ) {
          return false;
        }
        if (
          effectiveCapabilities?.availableModelFamilies &&
          effectiveCapabilities.availableModelFamilies.length > 0 &&
          !effectiveCapabilities.availableModelFamilies.includes(c.modelFamily)
        ) {
          return false;
        }
        return true;
      });

      const chosen =
        candidates.find(
          (c) =>
            !usedPairs.has(`${c.harness}:${c.model}`) &&
            !excludedFamilies.includes(c.modelFamily)
        ) ??
        candidates.find((c) => !usedPairs.has(`${c.harness}:${c.model}`)) ??
        candidates[0];
      if (chosen) {
        usedPairs.add(`${chosen.harness}:${chosen.model}`);
        if (chosen.modelFamily && !excludedFamilies.includes(chosen.modelFamily)) {
          excludedFamilies.push(chosen.modelFamily);
        }
        const remainingFallbacks = candidates.filter(
          (c) => !(c.harness === chosen.harness && c.model === chosen.model)
        );
        reviewers.push({
          role,
          harness: chosen.harness,
          model: chosen.model,
          modelFamily: chosen.modelFamily,
          diversityDegraded: false,
          fallbacks: remainingFallbacks,
        });
        continue;
      }
    }

    const sel = selectDiverseReviewer(
      proposerRoute,
      role,
      effectiveRoutingConfig,
      effectiveCapabilities,
      excludedFamilies
    );
    if (sel.diversityDegraded) diversityDegraded = true;

    const isDuplicateClone =
      !options.hasMockRunner &&
      !isExplicitRoleOrCountSelection &&
      reviewers.some((r) => r.harness === sel.harness && r.model === sel.model);

    if (isDuplicateClone) {
      diversityDegraded = true;
    } else {
      usedPairs.add(`${sel.harness}:${sel.model}`);
      if (sel.modelFamily && !excludedFamilies.includes(sel.modelFamily)) {
        excludedFamilies.push(sel.modelFamily);
      }
      reviewers.push({
        role,
        harness: sel.harness,
        model: sel.model,
        modelFamily: sel.modelFamily,
        diversityDegraded: sel.diversityDegraded,
        fallbacks: sel.route.fallbacks,
      });
    }
  }

  const families = new Set(reviewers.map((r) => r.modelFamily));
  if (reviewers.length > 1 && families.size === 1) {
    diversityDegraded = true;
  }

  return { reviewers, diversityDegraded };
}

// ============================================================================
// Core Debate Broker
// ============================================================================

const DEBATE_MAX_FALLBACK_RETRIES = 2;

function shouldRetryDebateAttempt(res: SpawnHybridSubagentResult): boolean {
  if (res.exitCode !== 0 || res.timedOut) return true;
  try {
    const outFile = path.join(path.dirname(res.metaPath), "output.log");
    if (!fs.existsSync(outFile)) return true;
    const raw = fs.readFileSync(outFile, "utf8");
    if (!parseReviewerOpening(raw)) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Executes zero-polling parallel blind cross-model debate.
 *
 * Flow:
 * 1. Select diverse reviewers prioritizing different modelFamily.
 * 2. Round 1: spawn reviewers in parallel with physical isolation.
 * 3. Graceful degradation: survive single-reviewer crash/timeout.
 * 4. Early Exit: if all surviving openings are APPROVE/MINOR_AMEND -> done.
 * 5. Round 2: if any opening is REJECT -> spawn Arbiter with Round 1 bundle.
 * 6. Persist results in SQLite debates table; append to tasks.acceptance and update PLAN.md.
 */
export async function runDebateBroker(
  options: RunDebateBrokerOptions
): Promise<DebateBrokerResult> {
  const debateId =
    options.debateId ??
    `D-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const ownsDb = !options.db;
  const db =
    options.db ?? openProjectDb(options.projectRoot, options.homeDir);

  let debateCreated = false;
  let debateFinalized = false;
  const spawnedDebateSubIds: string[] = [];

  try {
    // Ensure parent session row exists to satisfy SQLite foreign keys
    const defaultMemo = options.topic.trim().slice(0, 40);
    const existingSession = db.getSession(options.sessionId);
    if (!existingSession) {
      db.createOrGetSession({
        sessionId: options.sessionId,
        projectRoot: options.projectRoot,
        mainHarness:
          (options.proposerRoute?.harness as HarnessId) ?? "claude-code",
        memo: defaultMemo,
      });
    } else if (!existingSession.memo && defaultMemo) {
      db.updateSessionMemo(options.sessionId, defaultMemo);
    }

    // Initialize debate record in SQLite (status = 'round1')
    db.createDebate({
      debateId,
      sessionId: options.sessionId,
      taskId: options.taskId ?? null,
      topic: options.topic,
      status: "round1",
    });
    debateCreated = true;

    options.onProgress?.(
      `[Debate ${debateId}] Initialized debate for topic: "${options.topic}"`
    );

    // 1. Select Reviewers (explicit harnesses/roles/models/count or diverse auto-selection)
    const effectiveProposerRoute: ProposalRouteInput = options.proposerRoute ?? {
      harness: "claude-code",
      model: "claude-opus-5-5",
      modelFamily: "claude",
    };
    const effectiveRoutingConfig =
      options.routingConfig ??
      loadRoutingConfig(options.projectRoot, options.homeDir);
    const effectiveCapabilities: RuntimeCapabilities | undefined =
      options.runtimeCapabilities ??
      (!options.commandRunner ? detectLiveRuntimeCapabilities() : undefined);

    const resolvedSelection = resolveDebateReviewers({
      proposerRoute: effectiveProposerRoute,
      routingConfig: effectiveRoutingConfig,
      runtimeCapabilities: effectiveCapabilities,
      harnesses: options.harnesses,
      roles: options.roles,
      models: options.models,
      count: options.count,
      reviewerRoles: options.reviewerRoles,
      reviewerRoutes: options.reviewerRoutes,
      hasMockRunner: Boolean(options.commandRunner),
    });
    const reviewers = resolvedSelection.reviewers;
    let diversityDegraded = resolvedSelection.diversityDegraded;

    options.onProgress?.(
      `[Debate ${debateId}] Selected ${reviewers.length} reviewer(s): ` +
        reviewers.map((r) => `@${r.harness}/${r.model} (${r.role})`).join(", ")
    );

    // 2. Round 1: Blind Openings in parallel via Promise.allSettled
    const codeContext = buildDebateCodeContext(
      options.projectRoot,
      options.files,
      options.includeDiff
    );
    const effectiveTimeoutMs = options.timeoutMs ?? DEFAULT_DEBATE_TIMEOUT_MS;
    const effectiveIdleTimeoutMs =
      options.timeoutMs !== undefined ? undefined : DEFAULT_IDLE_TIMEOUT_MS;
    const logTaskId = options.taskId || debateId;

    const round1Promises = reviewers.map(async (reviewer, index) => {
      const subSessionId = `${options.sessionId}-deb-${debateId}-r1-${index + 1}`;
      const round1Prompt = buildRound1Prompt(
        options.topic,
        options.proposal,
        options.taskId,
        codeContext,
        reviewer.role
      );
      const r1Run = await runWithFallbacks({
        initialRoute: {
          harness: reviewer.harness,
          model: reviewer.model,
          modelFamily: reviewer.modelFamily,
          fallbacks: reviewer.fallbacks ?? [],
          tier: 2,
        },
        routingConfig: effectiveRoutingConfig,
        runtimeCapabilities: effectiveCapabilities,
        baseSubSessionId: subSessionId,
        allowDefaultModelRetry: !options.commandBuilder,
        maxRetries: DEBATE_MAX_FALLBACK_RETRIES,
        shouldRetry: shouldRetryDebateAttempt,
        attempt: (route, sid) => {
          spawnedDebateSubIds.push(sid);
          const cmdModel = route.model === "default" ? "" : route.model;
          const explicitCmd = options.commandBuilder
            ? options.commandBuilder(route.harness, round1Prompt, cmdModel)
            : undefined;
          return spawnHybridSubagent({
            projectRoot: options.projectRoot,
            homeDir: options.homeDir,
            mainSessionId: options.sessionId,
            subSessionId: sid,
            role: reviewer.role,
            harness: route.harness,
            model: route.model,
            taskId: logTaskId,
            prompt: round1Prompt,
            allowedFiles: [],
            ...(explicitCmd
              ? { command: explicitCmd.command, args: explicitCmd.args }
              : {}),
            dispatchMode: "debate",
            ownerPid: process.pid,
            commandRunner: options.commandRunner,
            transport: explicitCmd ? "cli" : options.transport,
            acpCommandOverride: options.acpCommandOverride,
            signal: options.signal,
            timeoutMs: effectiveTimeoutMs,
            idleTimeoutMs: effectiveIdleTimeoutMs,
            closeStdinOnSpawn: true,
          });
        },
      });
      const spawnResult = r1Run.result;
      const activeHarness = r1Run.harness;
      const activeModel = r1Run.model;
      const activeFamily = r1Run.modelFamily;

      if (spawnResult.exitCode !== 0) {
        const snippet = extractLogErrorSnippet(spawnResult.metaPath);
        throw new Error(
          `Reviewer process exited with non-zero exit code ${spawnResult.exitCode}${
            snippet ? ` (${snippet})` : ""
          }`
        );
      }

      const logPath = path.join(
        path.dirname(spawnResult.metaPath),
        "output.log"
      );
      let output = "";
      if (fs.existsSync(logPath)) {
        output = fs.readFileSync(logPath, "utf8");
      }

      const parsed = parseReviewerOpening(output);
      if (!parsed) {
        throw new Error(
          `Failed to parse structured verdict JSON from reviewer output (${reviewer.role})`
        );
      }

      const opening: ReviewerOpening = {
        reviewerId: `r1-${index + 1}`,
        role: reviewer.role,
        harness: activeHarness,
        model: activeModel,
        modelFamily: activeFamily,
        verdict: parsed.verdict,
        hard_constraints: parsed.hard_constraints,
        decisions: parsed.decisions,
        risks: parsed.risks,
        reasoning: parsed.reasoning,
        rawOutput: output,
        durationMs: spawnResult.durationMs,
      };
      return opening;
    });

    const settledResults = await Promise.allSettled(round1Promises);

    const survivingOpenings: ReviewerOpening[] = [];
    const failedReviewers: FailedReviewer[] = [];

    for (let i = 0; i < settledResults.length; i++) {
      const item = settledResults[i]!;
      const rev = reviewers[i]!;
      if (item.status === "fulfilled") {
        survivingOpenings.push(item.value);
      } else {
        const errorMsg =
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason);
        failedReviewers.push({
          reviewerId: `r1-${i + 1}`,
          role: rev.role,
          harness: rev.harness,
          model: rev.model,
          error: errorMsg,
        });
      }
    }

    // Graceful recovery check: must have at least 1 valid surviving opening
    if (survivingOpenings.length === 0) {
      debateFinalized = true;
      db.updateDebateVerdict(debateId, "failed", {
        round1BundleJson: JSON.stringify({
          openings: [],
          failedReviewers,
        }),
      });
      for (const sid of spawnedDebateSubIds) {
        finalizeSubagentArtifacts({
          projectRoot: options.projectRoot,
          sessionId: options.sessionId,
          subSessionId: sid,
          keep: "tail",
        });
      }
      const errDetails = failedReviewers
        .map((f) => `[@${f.harness}/${f.model}]: ${f.error}`)
        .join("; ");
      throw new Error(
        `All debate reviewers failed or timed out in Round 1: ${errDetails}`
      );
    }

    // Recompute post-run diversity degradation from surviving openings and active model families
    // (only when configured with >1 reviewer so intentional single-reviewer configs are not false-flagged)
    const survivingFamilies = new Set(
      survivingOpenings.map((o) => o.modelFamily.toLowerCase())
    );
    if (
      reviewers.length > 1 &&
      (survivingOpenings.length <= 1 || survivingFamilies.size <= 1)
    ) {
      diversityDegraded = true;
    }

    const round1Bundle: Round1Bundle = {
      openings: survivingOpenings,
      failedReviewers,
    };

    // Check for REJECT in surviving openings
    const rejectingOpenings = survivingOpenings.filter(
      (o) => o.verdict === "REJECT"
    );
    const hasReject = rejectingOpenings.length > 0;

    let round2Bundle: Round2Bundle | null = null;
    let insightVerdict: InsightVerdict;

    if (!hasReject) {
      // 3. Early Exit: All surviving openings are APPROVE or MINOR_AMEND
      insightVerdict = synthesizeInsightVerdict(
        survivingOpenings,
        diversityDegraded
      );

      db.updateDebateVerdict(debateId, "done", {
        round1BundleJson: JSON.stringify(round1Bundle),
        round2BundleJson: null,
        insightVerdictJson: JSON.stringify(insightVerdict),
      });
      debateFinalized = true;

      options.onProgress?.(
        `[Debate ${debateId}] Round 1 early exit: unanimous non-rejection (${insightVerdict.verdict})`
      );
    } else {
      // 4. Round 2: Conflict Resolution & Arbiter Verdict
      options.onProgress?.(
        `[Debate ${debateId}] Conflict detected in Round 1 (REJECT present). Triggering Round 2 Arbiter pass...`
      );

      db.updateDebateVerdict(debateId, "round2", {
        round1BundleJson: JSON.stringify(round1Bundle),
      });

      // Select Arbiter
      let arbiterSpec: ReviewerSpec;
      if (options.arbiterRoute) {
        arbiterSpec = {
          role: options.arbiterRoute.role ?? ("arbiter" as AgentRole),
          harness: options.arbiterRoute.harness,
          model: options.arbiterRoute.model,
          modelFamily:
            options.arbiterRoute.modelFamily ??
            inferModelFamily(
              options.arbiterRoute.model,
              options.arbiterRoute.harness
            ),
          diversityDegraded: false,
        };
      } else {
        const proposerFamily =
          effectiveProposerRoute.modelFamily ||
          inferModelFamily(
            effectiveProposerRoute.model || "",
            effectiveProposerRoute.harness as HarnessId | undefined
          );
        const arbiterExcludedFamilies = [
          proposerFamily,
          ...survivingOpenings.map((o) => o.modelFamily),
        ].filter(Boolean);
        const arbiterSel = selectDiverseReviewer(
          effectiveProposerRoute,
          "arbiter" as AgentRole,
          effectiveRoutingConfig,
          effectiveCapabilities,
          arbiterExcludedFamilies
        );
        if (arbiterSel.diversityDegraded) diversityDegraded = true;

        arbiterSpec = {
          role: "arbiter" as AgentRole,
          harness: arbiterSel.harness,
          model: arbiterSel.model,
          modelFamily: arbiterSel.modelFamily,
          diversityDegraded: arbiterSel.diversityDegraded,
          fallbacks: arbiterSel.route.fallbacks,
        };
      }

      const r2CitedContext = buildRound2CitedCodeContext(
        options.projectRoot,
        round1Bundle,
        options.files
      );
      const r2CodeContext =
        r2CitedContext && codeContext
          ? `${codeContext}\n\n${r2CitedContext}`
          : r2CitedContext || codeContext;

      const r2Prompt = buildRound2Prompt(
        options.topic,
        options.proposal,
        round1Bundle,
        options.taskId,
        r2CodeContext
      );
      const r2SubSessionId = `${options.sessionId}-deb-${debateId}-r2-arbiter`;

      let arbiterOpening: ReviewerOpening;
      try {
        const arbRun = await runWithFallbacks({
          initialRoute: {
            harness: arbiterSpec.harness,
            model: arbiterSpec.model,
            modelFamily: arbiterSpec.modelFamily,
            fallbacks: arbiterSpec.fallbacks ?? [],
            tier: 2,
          },
          routingConfig: effectiveRoutingConfig,
          runtimeCapabilities: effectiveCapabilities,
          baseSubSessionId: r2SubSessionId,
          allowDefaultModelRetry: !options.commandBuilder,
          maxRetries: DEBATE_MAX_FALLBACK_RETRIES,
          shouldRetry: shouldRetryDebateAttempt,
          attempt: (route, sid) => {
            spawnedDebateSubIds.push(sid);
            const cmdModel = route.model === "default" ? "" : route.model;
            const explicitCmd = options.commandBuilder
              ? options.commandBuilder(route.harness, r2Prompt, cmdModel)
              : undefined;
            return spawnHybridSubagent({
              projectRoot: options.projectRoot,
              homeDir: options.homeDir,
              mainSessionId: options.sessionId,
              subSessionId: sid,
              role: arbiterSpec.role,
              harness: route.harness,
              model: route.model,
              taskId: logTaskId,
              prompt: r2Prompt,
              allowedFiles: [],
              ...(explicitCmd
                ? { command: explicitCmd.command, args: explicitCmd.args }
                : {}),
              dispatchMode: "debate",
              ownerPid: process.pid,
              commandRunner: options.commandRunner,
              transport: explicitCmd ? "cli" : options.transport,
              acpCommandOverride: options.acpCommandOverride,
              signal: options.signal,
              timeoutMs: effectiveTimeoutMs,
              idleTimeoutMs: effectiveIdleTimeoutMs,
            });
          },
        });
        const arbResult = arbRun.result;

        if (arbResult.exitCode !== 0) {
          const snippet = extractLogErrorSnippet(arbResult.metaPath);
          throw new Error(
            `Arbiter process exited with code ${arbResult.exitCode}${
              snippet ? ` (${snippet})` : ""
            }`
          );
        }

        const arbLogPath = path.join(
          path.dirname(arbResult.metaPath),
          "output.log"
        );
        let arbOutput = "";
        if (fs.existsSync(arbLogPath)) {
          arbOutput = fs.readFileSync(arbLogPath, "utf8");
        }

        const parsedArb = parseReviewerOpening(arbOutput);
        if (!parsedArb) {
          throw new Error(
            "Failed to parse structured verdict JSON from arbiter output"
          );
        }

        arbiterOpening = {
          reviewerId: "r2-arbiter",
          role: arbiterSpec.role,
          harness: arbRun.harness,
          model: arbRun.model,
          modelFamily: arbRun.modelFamily,
          verdict: parsedArb.verdict,
          hard_constraints: parsedArb.hard_constraints,
          decisions: parsedArb.decisions,
          risks: parsedArb.risks,
          reasoning: parsedArb.reasoning,
          rawOutput: arbOutput,
          durationMs: arbResult.durationMs,
        };
      } catch (arbErr) {
        // Fallback resolution if Arbiter subagent crashes
        arbiterOpening = {
          reviewerId: "r2-arbiter-fallback",
          role: "arbiter" as AgentRole,
          harness: arbiterSpec.harness,
          model: arbiterSpec.model,
          modelFamily: arbiterSpec.modelFamily,
          verdict: "REJECT",
          hard_constraints: deduplicateStrings(
            survivingOpenings.flatMap((o) => o.hard_constraints)
          ),
          decisions: deduplicateStrings(
            survivingOpenings.flatMap((o) => o.decisions)
          ),
          risks: deduplicateStrings(survivingOpenings.flatMap((o) => o.risks)),
          reasoning: `Arbiter failed to complete (${
            arbErr instanceof Error ? arbErr.message : String(arbErr)
          }); defaulting to REJECT based on Round 1 conflicts.`,
        };
      }

      round2Bundle = {
        arbiterVerdict: arbiterOpening,
        round1Reference: round1Bundle,
      };

      // Arbiter holds sole authority for final hard_constraints & decisions
      // (r2-arbiter-fallback already populates arbiterOpening with Round 1 unions).
      const finalHardConstraints = deduplicateStrings(
        arbiterOpening.hard_constraints
      );
      const finalDecisions = deduplicateStrings(arbiterOpening.decisions);
      const finalRisks = deduplicateStrings([
        ...arbiterOpening.risks,
        ...survivingOpenings.flatMap((o) => o.risks),
      ]);

      insightVerdict = {
        verdict: arbiterOpening.verdict,
        hard_constraints: finalHardConstraints,
        decisions: finalDecisions,
        risks: finalRisks,
        diversity_degraded: diversityDegraded,
        reasoning: arbiterOpening.reasoning,
      };

      db.updateDebateVerdict(debateId, "done", {
        round1BundleJson: JSON.stringify(round1Bundle),
        round2BundleJson: JSON.stringify(round2Bundle),
        insightVerdictJson: JSON.stringify(insightVerdict),
      });
      debateFinalized = true;

      options.onProgress?.(
        `[Debate ${debateId}] Round 2 Arbiter completed with verdict: ${insightVerdict.verdict}`
      );
    }

    // 5. Automatic acceptance injection into tasks and PLAN.md update (skipped on REJECT)
    let updatedAcceptance: string | undefined;

    if (
      options.taskId &&
      options.taskId.trim().length > 0 &&
      insightVerdict.verdict !== "REJECT"
    ) {
      const acceptanceText = formatDebateAcceptance(
        debateId,
        insightVerdict.hard_constraints,
        insightVerdict.decisions
      );

      if (acceptanceText.length > 0) {
        db.injectDebateAcceptance(
          options.sessionId,
          options.taskId,
          acceptanceText
        );
      }

      const updatedTask = db.getTask(options.sessionId, options.taskId);
      updatedAcceptance = updatedTask?.acceptance ?? acceptanceText;

      // Automatically sync updated task acceptance into .asd/PLAN.md
      try {
        const sessionRow = db.getSession(options.sessionId);
        const taskRows = db.getSessionTasks(options.sessionId);
        if (sessionRow) {
          renderPlanMd(sessionRow, taskRows);
        }
      } catch {
        // Ignore PLAN.md rendering errors when running in isolated test DBs
      }
    }

    // Finalize all debate reviewer subagent artifacts now that debate is done
    for (const sid of spawnedDebateSubIds) {
      finalizeSubagentArtifacts({
        projectRoot: options.projectRoot,
        sessionId: options.sessionId,
        subSessionId: sid,
      });
    }

    // 6. Generate Progress Board markdown
    let progressBoard = "";
    try {
      const sessionRow = db.getSession(options.sessionId);
      const taskRows = db.getSessionTasks(options.sessionId);
      progressBoard = renderProgressBoard(sessionRow, taskRows);
    } catch {
      progressBoard =
        "### 📊 ASD TODO Progress [Turn 1/1 done | Progress: 0/0 (0%)]";
    }

    return {
      debateId,
      sessionId: options.sessionId,
      taskId: options.taskId ?? null,
      topic: options.topic,
      status: "done",
      verdict: insightVerdict.verdict,
      hardConstraints: insightVerdict.hard_constraints,
      decisions: insightVerdict.decisions,
      risks: insightVerdict.risks,
      diversityDegraded,
      updatedAcceptance,
      progressBoard,
      round1Bundle,
      round2Bundle,
      insightVerdict,
    };
  } finally {
    if (debateCreated && !debateFinalized) {
      try {
        db.updateDebateVerdict(debateId, "failed", {
          round1BundleJson: JSON.stringify({
            openings: [],
            error: "Debate aborted or crashed before completion",
          }),
        });
      } catch {
        // Ignore update failure during abnormal termination
      }
      for (const sid of spawnedDebateSubIds) {
        try {
          finalizeSubagentArtifacts({
            projectRoot: options.projectRoot,
            sessionId: options.sessionId,
            subSessionId: sid,
            keep: "tail",
          });
        } catch {
          // Best-effort cleanup
        }
      }
    }
    if (ownsDb) {
      try {
        db.close();
      } catch {
        // Already closed
      }
    }
  }
}
