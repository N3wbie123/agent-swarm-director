/**
 * ASD Session Drivers Management API (CR-01)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AcpStdioClient, probeAcpCapability } from "./acp-client.ts";
import type {
  AcpNormalizedEvent,
  AcpPermissionOption,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
} from "./acp-types.ts";
import {
  type DriverDetachReason,
  type DriverRow,
  type DriverSource,
  generateDriverId,
  type SqliteDriver,
} from "./db.ts";
import { resolveAsdPaths } from "./config.ts";
import { resolveOpenCodeCapabilityProfile } from "./opencode-profile.ts";
import { redactSecrets } from "./redact.ts";
import { atomicWriteFileSync, renderProgressBoard } from "./render.ts";
import {
  buildHeadlessHarnessCommand,
  buildResumeHarnessCommand,
  buildSpawnSpec,
  isValidAsdSessionId,
  recordCliRecentSession,
} from "./session-tracker.ts";
import { type CommandRunner, executeHarnessProcess } from "./spawner.ts";
import { isPidAlive } from "./workspace.ts";
import type {
  HarnessId,
  MainSessionDriverMeta,
  MainSessionMeta,
  OpenCodeCapabilityProfile,
  SessionPhase,
} from "./types.ts";

export type { DriverDetachReason, DriverRow, DriverSource };

function formatDriverForMainJson(row: DriverRow): MainSessionDriverMeta {
  return {
    driverId: row.driver_id,
    harness: row.harness,
    model: row.model ?? null,
    harnessSessionId: row.harness_session_id ?? null,
    source: row.source,
    attachedAt: row.attached_at,
    detachedAt: row.detached_at ?? null,
    detachReason: row.detach_reason ?? null,
  };
}

export function syncSessionDriversToMainJson(
  db: SqliteDriver,
  projectRoot: string,
  sessionId: string
): void {
  const sessionRow = db.getSession(sessionId);
  if (!sessionRow) return;

  const drivers = db.listDrivers(sessionId);
  const active = db.getActiveDriver(sessionId) ?? null;

  const sessionDir = path.join(path.resolve(projectRoot), ".asd", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const mainJsonPath = path.join(sessionDir, "main.json");

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(mainJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  const effectiveHarness =
    (active?.harness ?? (sessionRow.main_harness || "claude-code")) as HarnessId;
  const effectiveModel = active ? active.model : (sessionRow.main_model ?? null);
  const effectiveSid = active
    ? active.harness_session_id
    : (sessionRow.harness_session_id ?? null);

  const nextMeta: MainSessionMeta & Record<string, unknown> = {
    ...existing,
    sessionId,
    roleType: "main",
    harness: effectiveHarness,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    harnessSessionId: effectiveSid ?? null,
    autoApprove: sessionRow.auto_approve !== 0,
    activeDriverId: active ? active.driver_id : null,
    drivers: drivers.map(formatDriverForMainJson),
    role: "director",
    phase: (sessionRow.phase as SessionPhase) || "planning",
    pid: sessionRow.main_pid ?? process.pid,
    startedAt:
      typeof existing.startedAt === "string"
        ? existing.startedAt
        : new Date(sessionRow.created_at).toISOString(),
    ...(sessionRow.memo ? { memo: sessionRow.memo } : {}),
  };

  if (!effectiveModel && "model" in nextMeta) {
    delete nextMeta.model;
  }

  atomicWriteFileSync(mainJsonPath, JSON.stringify(nextMeta, null, 2) + "\n");
}

export function attachDriver(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    sessionId: string;
    harness: HarnessId;
    model?: string | null;
    harnessSessionId?: string | null;
    source: DriverSource;
    now?: number;
  }
): { driver: DriverRow; previousDriverId: string | null; changed: boolean } {
  const now = input.now ?? Date.now();
  const nextSid = input.harnessSessionId ?? null;
  const hasModelInput = input.model !== undefined;
  const nextModel = input.model ?? null;

  const txResult = db.withImmediateTx(() => {
    const session = db.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const active = db.getActiveDriver(input.sessionId);
    if (
      active &&
      active.harness === input.harness &&
      (active.harness_session_id ?? null) === nextSid
    ) {
      if (hasModelInput && nextModel !== (active.model ?? null)) {
        db["db"]
          .prepare("UPDATE session_drivers SET model = ? WHERE driver_id = ?")
          .run(nextModel, active.driver_id);
        db.updateSessionHarnessInfo(input.sessionId, {
          mainModel: nextModel,
        });
        db.incrementStateVersion(input.sessionId);
      }
      const refreshed = db.getDriver(active.driver_id) ?? active;
      return {
        driver: refreshed,
        previousDriverId: active.driver_id,
        changed: false,
      };
    }

    const previousDriverId = active ? active.driver_id : null;
    if (active) {
      db.detachDriverRow(active.driver_id, "switched", now);
    }

    const newDriver = db.insertDriver({
      driver_id: generateDriverId(now),
      session_id: input.sessionId,
      harness: input.harness,
      model: nextModel,
      harness_session_id: nextSid,
      source: input.source,
      attached_at: now,
      briefing_injected: 0,
    });

    db.updateSessionHarnessInfo(input.sessionId, {
      mainHarness: input.harness,
      mainModel: nextModel,
      harnessSessionId: nextSid,
    });
    db.incrementStateVersion(input.sessionId);

    return {
      driver: newDriver,
      previousDriverId,
      changed: true,
    };
  });

  syncSessionDriversToMainJson(db, input.projectRoot, input.sessionId);

  if (txResult.changed && txResult.previousDriverId) {
    void closeDriverSessionByDriverId(txResult.previousDriverId);
  }

  if (nextSid) {
    recordCliRecentSession(input.projectRoot, {
      harnessSessionId: nextSid,
      harness: input.harness,
      model: txResult.driver.model ?? null,
      asdSessionId: input.sessionId,
    });
  }

  return txResult;
}

export function setDriverHarnessSessionId(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    driverId: string;
    harnessSessionId: string;
    allowOverwrite?: boolean;
  }
): DriverRow {
  const sid = input.harnessSessionId.trim();
  if (!sid) {
    throw new Error("harnessSessionId must be a non-empty string");
  }

  const updated = db.withImmediateTx(() => {
    const existing = db.getDriver(input.driverId);
    if (!existing) {
      throw new Error(`Driver not found: ${input.driverId}`);
    }
    if (
      existing.harness_session_id !== null &&
      existing.harness_session_id !== undefined
    ) {
      if (existing.harness_session_id === sid) {
        return existing;
      }
      if (input.allowOverwrite !== true) {
        throw new Error(
          `Driver ${input.driverId} already has harness_session_id '${existing.harness_session_id}'`
        );
      }
    }

    db.setDriverHarnessSessionId(input.driverId, sid);
    if (existing.detached_at === null) {
      db.updateSessionHarnessInfo(existing.session_id, {
        harnessSessionId: sid,
      });
    }
    db.incrementStateVersion(existing.session_id);
    return db.getDriver(input.driverId)!;
  });

  syncSessionDriversToMainJson(db, input.projectRoot, updated.session_id);
  recordCliRecentSession(input.projectRoot, {
    harnessSessionId: sid,
    harness: updated.harness as HarnessId,
    model: updated.model ?? null,
    asdSessionId: updated.session_id,
  });

  return updated;
}

export function detachDriver(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    driverId?: string;
    sessionId?: string;
    reason: DriverDetachReason;
  }
): void {
  const detached = db.withImmediateTx(() => {
    const existing = input.driverId
      ? db.getDriver(input.driverId)
      : input.sessionId
        ? db.getActiveDriver(input.sessionId)
        : undefined;
    if (!existing) {
      if (input.sessionId && !input.driverId) {
        return { sessionId: input.sessionId, driverId: null as string | null };
      }
      throw new Error(`Driver not found: ${input.driverId ?? input.sessionId ?? "unknown"}`);
    }
    if (existing.detached_at === null) {
      db.detachDriverRow(existing.driver_id, input.reason, Date.now());
      db.incrementStateVersion(existing.session_id);
    }
    return { sessionId: existing.session_id, driverId: existing.driver_id };
  });

  if (detached.driverId) {
    void closeDriverSessionByDriverId(detached.driverId);
  }

  syncSessionDriversToMainJson(db, input.projectRoot, detached.sessionId);
}

export function getActiveDriver(
  db: SqliteDriver,
  sessionId: string
): DriverRow | null {
  return db.getActiveDriver(sessionId) ?? null;
}

export function listDrivers(db: SqliteDriver, sessionId: string): DriverRow[] {
  return db.listDrivers(sessionId);
}

// ============================================================================
// CR-02: 0-Token Driver Briefing (buildDriverBriefing)
// ============================================================================

export function buildDriverBriefing(input: {
  db: SqliteDriver;
  projectRoot: string;
  sessionId: string;
  maxChars?: number;
  locale?: "ko" | "en";
}): string {
  const maxChars = input.maxChars ?? 6000;
  const sysLang: "ko" | "en" = input.locale ?? "en";

  const session = input.db.getSession(input.sessionId);
  const paths = resolveAsdPaths(input.projectRoot);
  const tasks = session ? input.db.getSessionTasks(input.sessionId) : [];
  const drivers = session ? input.db.listDrivers(input.sessionId) : [];
  const activeDriver = session ? input.db.getActiveDriver(input.sessionId) : undefined;

  // 1. Header
  const headerLines = [
    "# ASD Session Briefing",
    `- Session ID: ${input.sessionId}`,
    `- Memo: ${session?.memo ?? "(none)"}`,
    `- Phase: ${session?.phase ?? "planning"}`,
    `- Auto Approve: ${session ? session.auto_approve !== 0 : true}`,
    `- Project Root: ${path.resolve(input.projectRoot)}`,
    `- PLAN.md: ${paths.planMdPath}`,
  ];
  const sec1 = headerLines.join("\n");

  // 2. Previous drivers (excluding current active driver)
  const prevDrivers = drivers.filter(
    (d) => !activeDriver || d.driver_id !== activeDriver.driver_id
  );
  let sec2 = "";
  if (prevDrivers.length > 0) {
    const lines = ["## Previous Drivers"];
    for (const d of prevDrivers) {
      const startIso = new Date(d.attached_at).toISOString();
      const endIso = d.detached_at ? new Date(d.detached_at).toISOString() : "active";
      const modelStr = d.model ? `/${d.model}` : "";
      const sidStr = d.harness_session_id ? ` (sid: ${d.harness_session_id})` : "";
      lines.push(`- ${d.harness}${modelStr}${sidStr} [${startIso} ~ ${endIso}]`);
    }
    sec2 = lines.join("\n");
  }

  // 3. Progress board (only if tasks exist)
  let sec3 = "";
  if (session && tasks.length > 0) {
    sec3 = renderProgressBoard(session, tasks).trim();
  }

  // 4. Attention needed tasks (verifying, merge_conflict, failed, escalated)
  const attentionStatuses = new Set(["verifying", "merge_conflict", "failed", "escalated"]);
  const attentionTasks = tasks.filter((t) => attentionStatuses.has(t.status));
  let sec4 = "";
  if (attentionTasks.length > 0) {
    const lines = ["## Attention Needed Tasks"];
    for (const t of attentionTasks) {
      const wtInfo = t.worktree_path ? ` | worktree: ${t.worktree_path}` : "";
      lines.push(`- **${t.task_id}** [${t.status}]: ${t.title}${wtInfo}`);
    }
    sec4 = lines.join("\n");
  }

  // 5. Recently completed task summaries (done_claim_json.summary & key_decisions, newest first)
  const doneTasks = tasks
    .filter((t) => t.status === "done" && t.done_claim_json)
    .slice()
    .sort((a, b) => {
      const diff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
      if (diff !== 0) return diff;
      const turnDiff = b.turn - a.turn;
      if (turnDiff !== 0) return turnDiff;
      return b.task_id.localeCompare(a.task_id, undefined, { numeric: true });
    });
  let sec5 = "";
  if (doneTasks.length > 0) {
    const lines = ["## Recently Completed Tasks"];
    for (const t of doneTasks) {
      try {
        const claim = JSON.parse(t.done_claim_json!) as {
          summary?: string;
          key_decisions?: string[];
        };
        const summary = claim.summary ?? "";
        const decisions =
          Array.isArray(claim.key_decisions) && claim.key_decisions.length > 0
            ? ` (Decisions: ${claim.key_decisions.join("; ")})`
            : "";
        lines.push(`- **${t.task_id}** (${t.title}): ${summary}${decisions}`);
      } catch {
        lines.push(`- **${t.task_id}** (${t.title})`);
      }
    }
    sec5 = lines.join("\n");
  }

  // 6. summary.md first 1,500 chars if present
  let sec6 = "";
  const sessionSummaryPath = path.join(
    path.resolve(input.projectRoot),
    ".asd",
    "sessions",
    input.sessionId,
    "summary.md"
  );
  const fallbackSummaryPath = path.join(paths.localViewDir, "summary.md");
  const summaryPath = fs.existsSync(sessionSummaryPath)
    ? sessionSummaryPath
    : fs.existsSync(fallbackSummaryPath)
      ? fallbackSummaryPath
      : null;
  if (summaryPath) {
    try {
      const rawSummary = fs.readFileSync(summaryPath, "utf8").trim();
      if (rawSummary.length > 0) {
        sec6 = `## Session Summary\n${rawSummary.slice(0, 1500)}`;
      }
    } catch {
      // ignore
    }
  }

  // 7. Guidance footer
  const sec7 =
    sysLang === "en"
      ? "## Guidance\nUse the official `asd` CLI (`asd plan`, `asd dispatch`, `asd verify`, `asd debate`) for task planning, dispatching, and verification. Merge-conflict tasks are reviewed and resolved/re-merged or rejected by the user."
      : "## 안내\n태스크 계획/디스패치/검증은 공식 `asd` CLI(`asd plan`, `asd dispatch`, `asd verify`, `asd debate`)를 사용하라. 병합 충돌 태스크는 사용자가 검토 후 해결·재병합하거나 반려한다.";

  const assemble = (s3: string, s5: string, s6: string): string =>
    [sec1, sec2, s3, sec4, s5, s6, sec7].filter((s) => s.length > 0).join("\n\n");

  const suffix = "…(truncated)";
  let cur3 = sec3;
  let cur5 = sec5;
  let cur6 = sec6;

  let full = assemble(cur3, cur5, cur6);
  let truncated = false;

  // Truncate in exact order: 5 -> 6 -> 3
  const shrinkSection = (
    current: string,
    buildWith: (val: string) => string
  ): string => {
    if (!current) return current;
    const without = buildWith("");
    if (without.length >= maxChars) {
      truncated = true;
      return "";
    }
    const budget = Math.max(0, maxChars - without.length - 2);
    truncated = true;
    return budget > 0 ? current.slice(0, budget) : "";
  };

  if (full.length > maxChars && cur5.length > 0) {
    cur5 = shrinkSection(cur5, (v) => assemble(cur3, v, cur6));
    full = assemble(cur3, cur5, cur6);
  }
  if (full.length > maxChars && cur6.length > 0) {
    cur6 = shrinkSection(cur6, (v) => assemble(cur3, cur5, v));
    full = assemble(cur3, cur5, cur6);
  }
  if (full.length > maxChars && cur3.length > 0) {
    cur3 = shrinkSection(cur3, (v) => assemble(v, cur5, cur6));
    full = assemble(cur3, cur5, cur6);
  }
  if (full.length > maxChars) {
    full = full.slice(0, maxChars);
    truncated = true;
  }

  if (truncated) {
    if (full.length > maxChars) {
      full = full.slice(0, maxChars);
    }
    full = `${full}${suffix}`;
  }

  return redactSecrets(full);
}


// ============================================================================
// Headless driver turn runner (streaming SDK entry)
// ============================================================================

export interface DriverRunResult {
  runId: string;
  driverId: string;
  exitCode: number;
  timedOut: boolean;
  harnessSessionId: string | null;
  durationMs: number;
  metaPath: string;
}

const activeDriverRuns = new Set<string>();

function getDefaultModelForHarness(harness: HarnessId): string {
  switch (harness) {
    case "claude-code":
      return "claude-sonnet-5-5";
    case "codex":
      return "gpt-6-luna";
    case "opencode":
      return "z-ai/glm-5.3-flash";
    case "antigravity":
      return "gemini-4-carbon-high";
    case "cursor":
      return "claude-sonnet-5-5-medium";
    default:
      return "claude-sonnet-5-5";
  }
}

function generateDriverRunId(now = Date.now()): string {
  const ts = Math.max(0, Math.floor(now)).toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `run-${ts}-${rand}`;
}

function pruneDriverRuns(runsDir: string, maxRuns = 50): void {
  if (!fs.existsSync(runsDir)) return;
  try {
    const entries = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    if (entries.length <= maxRuns) return;

    const withTimes = entries.map((e) => {
      const dirPath = path.join(runsDir, e.name);
      const metaPath = path.join(dirPath, "meta.json");
      let startedAt = 0;
      try {
        if (fs.existsSync(metaPath)) {
          const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            startedAt?: number;
          };
          if (typeof parsed.startedAt === "number") {
            startedAt = parsed.startedAt;
          }
        }
        if (!startedAt) {
          startedAt = fs.statSync(dirPath).mtimeMs;
        }
      } catch {
        startedAt = 0;
      }
      return { name: e.name, dirPath, startedAt };
    });

    withTimes.sort((a, b) => b.startedAt - a.startedAt);
    for (const old of withTimes.slice(maxRuns)) {
      try {
        fs.rmSync(old.dirPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

export type DriverStreamEventType =
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "text"
  | "status"
  | "raw";

export interface DriverStreamEvent {
  type: DriverStreamEventType;
  harness: HarnessId;
  text?: string;
  thinking?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
  harnessSessionId?: string;
  timestamp: number;
}

export interface StreamParserOptions {
  harness: HarnessId;
  sessionId?: string;
  subSessionId?: string;
  sse?: boolean;
  now?: () => number;
}

export interface TypedStatefulStreamParser {
  pushChunk(chunk: string | Buffer): DriverStreamEvent[];
  flush(): DriverStreamEvent[];
}

export interface OpenCodeServerEndpoints {
  profile: OpenCodeCapabilityProfile;
  baseUrl: string;
  eventPath: string;
  eventUrl: string;
  abortPathTemplate: string;
  buildAbortPath: (sessionId: string) => string;
  buildAbortUrl: (sessionId: string) => string;
}

export interface OpenCodeSseStreamResult {
  ok: boolean;
  status?: number;
  url: string;
  events: DriverStreamEvent[];
  error?: string;
}

function normalizeServerPath(rawPath: string, fallbackPath: string): string {
  const chosen = rawPath.trim() || fallbackPath;
  return chosen.startsWith("/") ? chosen : `/${chosen}`;
}

/**
 * Resolves OpenCode `serve` SSE and abort/interrupt endpoints from the active
 * V1/V2 capability profile (`/api/event` & `/api/session/{sessionId}/interrupt` on V2,
 * `/event` & `/session/{sessionId}/abort` on V1).
 */
export function resolveOpenCodeServerEndpoints(
  serverUrl: string,
  options?: {
    env?: Record<string, string | undefined>;
    profile?: OpenCodeCapabilityProfile;
  }
): OpenCodeServerEndpoints {
  const profile =
    options?.profile ?? resolveOpenCodeCapabilityProfile({ env: options?.env });
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const isV2 = profile.effectiveProfile === "v2";
  const eventPath = normalizeServerPath(
    profile.serverEventPath,
    isV2 ? "/api/event" : "/event"
  );
  const abortPathTemplate = normalizeServerPath(
    profile.serverAbortPathTemplate,
    isV2 ? "/api/session/{sessionId}/interrupt" : "/session/{sessionId}/abort"
  );
  const buildAbortPath = (sessionId: string): string =>
    abortPathTemplate.replace("{sessionId}", encodeURIComponent(sessionId));

  return {
    profile,
    baseUrl,
    eventPath,
    eventUrl: `${baseUrl}${eventPath}`,
    abortPathTemplate,
    buildAbortPath,
    buildAbortUrl: (sessionId: string) => `${baseUrl}${buildAbortPath(sessionId)}`,
  };
}

/**
 * Sends a best-effort abort/interrupt request to a running OpenCode server using the
 * profile-resolved endpoint (`/api/session/{sessionId}/interrupt` on V2 vs
 * `/session/{sessionId}/abort` on V1) and aborts any local SSE AbortController.
 */
export async function abortOpenCodeServerSession(options: {
  serverUrl: string;
  sessionId: string;
  env?: Record<string, string | undefined>;
  profile?: OpenCodeCapabilityProfile;
  abortController?: AbortController;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  options.abortController?.abort();
  if (!options.serverUrl || !options.sessionId) {
    return false;
  }
  const endpoints = resolveOpenCodeServerEndpoints(options.serverUrl, {
    env: options.env,
    profile: options.profile,
  });
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchFn(endpoints.buildAbortUrl(options.sessionId), {
      method: "POST",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Subscribes to an OpenCode `serve` SSE stream (`/api/event` on V2, `/event` on V1)
 * and feeds chunks through `createStreamParser({ harness: "opencode" })`.
 * Returns `{ ok: false }` cleanly on HTTP/network failure so callers can fall back to CLI.
 */
export async function streamOpenCodeServerEvents(options: {
  serverUrl: string;
  env?: Record<string, string | undefined>;
  profile?: OpenCodeCapabilityProfile;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onEvent?: (event: DriverStreamEvent) => void;
  onRawChunk?: (chunk: string) => void;
}): Promise<OpenCodeSseStreamResult> {
  const endpoints = resolveOpenCodeServerEndpoints(options.serverUrl, {
    env: options.env,
    profile: options.profile,
  });
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const parser = createStreamParser({ harness: "opencode", sse: true });
  const events: DriverStreamEvent[] = [];

  try {
    const res = await fetchFn(endpoints.eventUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: options.signal,
    });
    if (!res.ok || !res.body) {
      return {
        ok: false,
        status: res.status,
        url: endpoints.eventUrl,
        events,
        error: `OpenCode SSE endpoint returned HTTP ${res.status}`,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;
      options.onRawChunk?.(text);
      for (const ev of parser.pushChunk(text)) {
        events.push(ev);
        options.onEvent?.(ev);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      options.onRawChunk?.(tail);
      for (const ev of parser.pushChunk(tail)) {
        events.push(ev);
        options.onEvent?.(ev);
      }
    }
    for (const ev of parser.flush()) {
      events.push(ev);
      options.onEvent?.(ev);
    }

    return {
      ok: true,
      status: res.status,
      url: endpoints.eventUrl,
      events,
    };
  } catch (err) {
    return {
      ok: false,
      url: endpoints.eventUrl,
      events,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Attempts OpenCode server SSE streaming and falls back cleanly to streaming CLI
 * execution when the server API fails or is unreachable.
 */
export async function runOpenCodeSseWithCliFallback<T>(options: {
  serverUrl: string;
  env?: Record<string, string | undefined>;
  profile?: OpenCodeCapabilityProfile;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onEvent?: (event: DriverStreamEvent) => void;
  onRawChunk?: (chunk: string) => void;
  fallbackToCli: (context: {
    profile: OpenCodeCapabilityProfile;
    sseResult: OpenCodeSseStreamResult;
  }) => Promise<T>;
}): Promise<
  | { mode: "daemon-sse"; result: OpenCodeSseStreamResult }
  | { mode: "cli-fallback"; result: T }
> {
  const profile =
    options.profile ?? resolveOpenCodeCapabilityProfile({ env: options.env });
  const sseResult = await streamOpenCodeServerEvents({
    serverUrl: options.serverUrl,
    env: options.env,
    profile,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    onEvent: options.onEvent,
    onRawChunk: options.onRawChunk,
  });
  if (sseResult.ok) {
    return { mode: "daemon-sse", result: sseResult };
  }
  const fallbackRes = await options.fallbackToCli({ profile, sseResult });
  return { mode: "cli-fallback", result: fallbackRes };
}

function applyOpenCodeHeadlessFlags(
  args: readonly string[],
  profile: OpenCodeCapabilityProfile
): string[] {
  const next =
    profile.effectiveProfile === "v2"
      ? args.filter((arg) => arg !== "--pure")
      : [...args];
  const flagsToAdd = profile.headlessRunFlags.filter(
    (flag) => flag && !next.includes(flag)
  );
  if (flagsToAdd.length === 0) {
    return next;
  }
  const modelIdx = next.indexOf("--model");
  if (modelIdx !== -1) {
    next.splice(modelIdx, 0, ...flagsToAdd);
  } else {
    next.push(...flagsToAdd);
  }
  return next;
}

/**
 * Creates a stateful stream parser supporting arbitrary chunk boundaries,
 * multi-line SSE framing (opencode serve), content_block tool_use assembly,
 * and Cursor duplicate assistant text deduplication.
 */
export function createStreamParser(ctx: StreamParserOptions): TypedStatefulStreamParser {
  const harness = ctx.harness;
  const getNow = ctx.now ?? (() => Date.now());

  let lineBuffer = "";
  let sseEvent = "";
  let inSseStream = ctx.sse === true;

  // Tool block assembly state for content_block_start / content_block_delta
  const activeToolBlocks = new Map<
    number,
    { id?: string; name: string; partialJson: string }
  >();

  // Deduplication state for Cursor assistant text (consecutive only)
  let cursorAccumulatedText = "";
  let cursorLastEmittedText = "";

  function processParsedLine(rawLine: string): DriverStreamEvent[] {
    const trimmed = rawLine.trim();
    if (!trimmed) return [];

    // 1. Check for SSE framing (opencode serve)
    if (trimmed.startsWith("event:")) {
      inSseStream = true;
      sseEvent = trimmed.slice(6).trim();
      void sseEvent;
      return [];
    }
    if (
      (inSseStream &&
        (trimmed.startsWith(":") ||
          trimmed.startsWith("id:") ||
          trimmed.startsWith("retry:"))) ||
      (harness === "opencode" &&
        (trimmed.startsWith(":") ||
          /^id:\s*\S+$/.test(trimmed) ||
          /^retry:\s*\d+$/.test(trimmed)))
    ) {
      inSseStream = true;
      return [];
    }
    if (trimmed.startsWith("data:")) {
      inSseStream = true;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        sseEvent = "";
        return [];
      }
      return processParsedLine(payload);
    }

    if (!trimmed.startsWith("{")) {
      return [{ type: "raw", harness, text: trimmed, timestamp: getNow() }];
    }

    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return [{ type: "raw", harness, text: trimmed, timestamp: getNow() }];
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      return [{ type: "raw", harness, text: trimmed, timestamp: getNow() }];
    }

    const lineType = typeof obj.type === "string" ? obj.type : "";
    const index = typeof obj.index === "number" ? obj.index : 0;

    // 2. Stateful assembly: content_block_start (tool_use)
    if (lineType === "content_block_start" && obj.content_block && typeof obj.content_block === "object") {
      const cb = obj.content_block as Record<string, unknown>;
      if (cb.type === "tool_use") {
        const id = typeof cb.id === "string" ? cb.id : undefined;
        const name = typeof cb.name === "string" ? cb.name : "tool";
        let initialJson = "";
        if (typeof cb.input === "string") {
          initialJson = cb.input;
        } else if (cb.input && typeof cb.input === "object" && Object.keys(cb.input).length > 0) {
          initialJson = JSON.stringify(cb.input);
        }
        activeToolBlocks.set(index, { id, name, partialJson: initialJson });
        return [];
      }
    }

    // 3. Stateful assembly: content_block_delta (input_json_delta)
    if (lineType === "content_block_delta" && obj.delta && typeof obj.delta === "object") {
      const delta = obj.delta as Record<string, unknown>;
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const tb = activeToolBlocks.get(index);
        if (tb) {
          tb.partialJson += delta.partial_json;
        }
        return [];
      }
    }

    // 4. Stateful assembly: content_block_stop
    if (lineType === "content_block_stop") {
      const tb = activeToolBlocks.get(index);
      if (tb) {
        activeToolBlocks.delete(index);
        return [
          {
            type: "tool_use",
            harness,
            toolName: tb.name,
            ...(tb.id ? { toolId: tb.id } : {}),
            toolInput: tb.partialJson,
            timestamp: getNow(),
          },
        ];
      }
      return [];
    }

    // 5. Cursor duplicate block deduplication (consecutive only)
    if (harness === "cursor") {
      if (lineType === "result" && typeof obj.result === "string") {
        const resText = obj.result.trim();
        const isDuplicate = resText.length > 0 && resText === cursorLastEmittedText;
        if (isDuplicate) {
          if (typeof obj.session_id === "string" && obj.session_id) {
            return [
              {
                type: "status",
                harness,
                harnessSessionId: obj.session_id,
                timestamp: getNow(),
              },
            ];
          }
          return [];
        }
      }
    }

    // 6. Fallback to backward-compatible line parsing
    const events = parseDriverStreamLine(trimmed, harness, getNow());

    if (harness === "cursor") {
      let emittedText = false;
      for (const ev of events) {
        if (ev.type === "text" && ev.text) {
          cursorAccumulatedText += ev.text;
          cursorLastEmittedText = ev.text.trim();
          emittedText = true;
        }
      }
      // Reset consecutive duplicate tracking on non-text events
      if (!emittedText && events.length > 0) {
        cursorLastEmittedText = "";
      }
    }

    return events;
  }

  return {
    pushChunk(chunk: string | Buffer): DriverStreamEvent[] {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      lineBuffer += str;
      const events: DriverStreamEvent[] = [];

      let nlIdx = lineBuffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = lineBuffer.slice(0, nlIdx).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(nlIdx + 1);
        const parsed = processParsedLine(line);
        for (const ev of parsed) {
          events.push(ev);
        }
        nlIdx = lineBuffer.indexOf("\n");
      }

      return events;
    },

    flush(): DriverStreamEvent[] {
      const events: DriverStreamEvent[] = [];
      const remaining = lineBuffer.replace(/\r$/, "").trim();
      if (remaining.length > 0) {
        const parsed = processParsedLine(remaining);
        for (const ev of parsed) {
          events.push(ev);
        }
        lineBuffer = "";
      }

      for (const [, tb] of activeToolBlocks.entries()) {
        events.push({
          type: "tool_use",
          harness,
          toolName: tb.name,
          ...(tb.id ? { toolId: tb.id } : {}),
          toolInput: tb.partialJson,
          timestamp: getNow(),
        });
      }
      activeToolBlocks.clear();

      return events;
    },
  };
}

/**
 * Parses a single redacted stdout/stderr line from a running harness CLI
 * (`claude`, `codex`, `opencode`, `agy`, `agent`) into zero or more structured
 * `DriverStreamEvent` objects for real-time rendering by clients.
 */
export function parseDriverStreamLine(
  rawLine: string,
  harness: HarnessId,
  now = Date.now()
): DriverStreamEvent[] {
  const trimmed = rawLine.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{")) {
    return [{ type: "raw", harness, text: trimmed, timestamp: now }];
  }

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [{ type: "raw", harness, text: trimmed, timestamp: now }];
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return [{ type: "raw", harness, text: trimmed, timestamp: now }];
  }

  const events: DriverStreamEvent[] = [];
  const lineType = typeof obj.type === "string" ? obj.type : "";

  // 0. Cursor stream-json top-level events (live-verified 2026-11)
  if (lineType === "thinking") {
    // {"type":"thinking","subtype":"delta"|"completed","text":"..."}
    if (obj.subtype !== "completed" && typeof obj.text === "string" && obj.text) {
      events.push({ type: "thinking", harness, thinking: obj.text, timestamp: now });
    }
    return events;
  }
  if (lineType === "tool_call") {
    // {"type":"tool_call","subtype":"started"|"completed","call_id":"...",
    //  "tool_call":{"shellToolCall"|"readToolCall"|"globToolCall"|...:
    //    {"args":{...},"result":{"success":{...}|{"error":{"errorMessage":"..."}}}}}}
    const tc =
      obj.tool_call && typeof obj.tool_call === "object"
        ? (obj.tool_call as Record<string, unknown>)
        : undefined;
    const familyKey = tc
      ? Object.keys(tc).find(
          (k) => k.endsWith("ToolCall") && tc[k] && typeof tc[k] === "object"
        )
      : undefined;
    const family =
      familyKey && tc ? ((tc[familyKey] ?? {}) as Record<string, unknown>) : {};
    const toolName = familyKey ? familyKey.replace(/ToolCall$/, "") : "tool";
    const toolId =
      typeof obj.call_id === "string"
        ? obj.call_id
        : typeof tc?.toolCallId === "string"
          ? (tc.toolCallId as string)
          : undefined;
    if (obj.subtype === "completed") {
      const res =
        family.result && typeof family.result === "object"
          ? (family.result as Record<string, unknown>)
          : undefined;
      const errObj =
        res?.error && typeof res.error === "object"
          ? (res.error as Record<string, unknown>)
          : undefined;
      let out = "";
      if (res && res.success !== undefined) out = JSON.stringify(res.success);
      else if (errObj && typeof errObj.errorMessage === "string") out = errObj.errorMessage;
      else if (typeof family.output === "string") out = family.output;
      events.push({
        type: "tool_result",
        harness,
        toolName,
        ...(toolId ? { toolId } : {}),
        toolOutput: out,
        ...(errObj ? { isError: true } : {}),
        timestamp: now,
      });
      return events;
    }
    const rawArgs = family.args ?? family.input;
    events.push({
      type: "tool_use",
      harness,
      toolName,
      ...(toolId ? { toolId } : {}),
      ...(rawArgs !== undefined
        ? { toolInput: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs) }
        : {}),
      timestamp: now,
    });
    return events;
  }

  // 1. Claude Code / Cursor stream-json & json formats
  if (lineType === "content_block_delta" && obj.delta && typeof obj.delta === "object") {
    const delta = obj.delta as Record<string, unknown>;
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      events.push({ type: "thinking", harness, thinking: delta.thinking, timestamp: now });
      return events;
    }
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      events.push({ type: "text", harness, text: delta.text, timestamp: now });
      return events;
    }
  }

  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      // Skip plain user prompt echoes (Cursor stream-json "user" events);
      // user events carrying tool_result blocks (Claude SDK) still parse below.
      if (
        msg.role === "user" &&
        !(msg.content as unknown[]).some(
          (b) => b && typeof b === "object" && (b as Record<string, unknown>).type !== "text"
        )
      ) {
        return [];
      }
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          events.push({ type: "thinking", harness, thinking: b.thinking.trim(), timestamp: now });
        } else if (b.type === "tool_use") {
          const toolName = typeof b.name === "string" ? b.name : "tool";
          const toolId = typeof b.id === "string" ? b.id : undefined;
          const toolInput =
            b.input !== undefined
              ? typeof b.input === "string"
                ? b.input
                : JSON.stringify(b.input)
              : undefined;
          events.push({
            type: "tool_use",
            harness,
            toolName,
            ...(toolId ? { toolId } : {}),
            ...(toolInput !== undefined ? { toolInput } : {}),
            timestamp: now,
          });
        } else if (b.type === "tool_result") {
          const toolId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
          const out =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content
                    .map((p: unknown) =>
                      p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string"
                        ? String((p as Record<string, unknown>).text)
                        : ""
                    )
                    .filter(Boolean)
                    .join("\n")
                : "";
          events.push({
            type: "tool_result",
            harness,
            toolOutput: out,
            ...(toolId ? { toolId } : {}),
            ...(b.is_error === true ? { isError: true } : {}),
            timestamp: now,
          });
        } else if (typeof b.text === "string" && b.text.trim()) {
          events.push({ type: "text", harness, text: b.text, timestamp: now });
        }
      }
      if (events.length > 0) return events;
    } else if (typeof msg.content === "string" && msg.content.trim()) {
      events.push({ type: "text", harness, text: msg.content, timestamp: now });
      return events;
    }
  }

  if (lineType === "result" && typeof obj.result === "string" && obj.result.trim()) {
    events.push({
      type: "text",
      harness,
      text: obj.result,
      ...(typeof obj.session_id === "string" ? { harnessSessionId: obj.session_id } : {}),
      timestamp: now,
    });
    return events;
  }

  // 2. Codex `--json` events (`item.started`, `item.completed`, `response_item`, `event_msg`)
  const codexItem =
    (obj.item && typeof obj.item === "object" ? (obj.item as Record<string, unknown>) : undefined) ??
    (obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : undefined);
  if (codexItem) {
    const itemType = typeof codexItem.type === "string" ? codexItem.type : "";
    if (itemType === "reasoning" || itemType === "agent_reasoning") {
      let th = typeof codexItem.text === "string" ? codexItem.text : "";
      if (!th && Array.isArray(codexItem.summary)) {
        th = codexItem.summary
          .map((s: unknown) =>
            s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string"
              ? String((s as Record<string, unknown>).text)
              : ""
          )
          .filter(Boolean)
          .join("\n");
      }
      if (th.trim()) {
        events.push({ type: "thinking", harness, thinking: th.trim(), timestamp: now });
        return events;
      }
    }
    if (itemType === "agent_message" || (itemType === "message" && codexItem.role === "assistant")) {
      const txt =
        typeof codexItem.text === "string"
          ? codexItem.text
          : typeof codexItem.message === "string"
            ? codexItem.message
            : Array.isArray(codexItem.content)
              ? codexItem.content
                  .map((c: unknown) =>
                    c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
                      ? String((c as Record<string, unknown>).text)
                      : ""
                  )
                  .filter(Boolean)
                  .join("\n")
              : "";
      if (txt.trim()) {
        events.push({ type: "text", harness, text: txt, timestamp: now });
        return events;
      }
    }
    if (
      itemType === "command_execution" ||
      itemType === "function_call" ||
      itemType === "custom_tool_call" ||
      itemType === "mcp_tool_call"
    ) {
      const toolName =
        typeof codexItem.name === "string"
          ? codexItem.name
          : itemType === "command_execution"
            ? "shell"
            : itemType;
      const toolId =
        typeof codexItem.call_id === "string"
          ? codexItem.call_id
          : typeof codexItem.id === "string"
            ? codexItem.id
            : undefined;
      if (
        lineType === "item.completed" &&
        typeof codexItem.aggregated_output === "string"
      ) {
        events.push({
          type: "tool_result",
          harness,
          toolName,
          toolOutput: codexItem.aggregated_output,
          ...(toolId ? { toolId } : {}),
          ...(typeof codexItem.exit_code === "number" && codexItem.exit_code !== 0
            ? { isError: true }
            : {}),
          timestamp: now,
        });
        return events;
      }
      const rawIn = codexItem.command ?? codexItem.arguments ?? codexItem.input;
      const toolInput =
        rawIn !== undefined
          ? typeof rawIn === "string"
            ? rawIn
            : JSON.stringify(rawIn)
          : undefined;
      events.push({
        type: "tool_use",
        harness,
        toolName,
        ...(toolId ? { toolId } : {}),
        ...(toolInput !== undefined ? { toolInput } : {}),
        timestamp: now,
      });
      return events;
    }
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const toolId = typeof codexItem.call_id === "string" ? codexItem.call_id : undefined;
      const out = typeof codexItem.output === "string" ? codexItem.output : JSON.stringify(codexItem.output ?? "");
      events.push({
        type: "tool_result",
        harness,
        toolOutput: out,
        ...(toolId ? { toolId } : {}),
        timestamp: now,
      });
      return events;
    }
  }

  // 3. OpenCode `--format json` and `opencode serve` SSE events (`part`, `properties.part`, or `payload`)
  const ocEnvelope =
    harness === "opencode" &&
    obj.payload &&
    typeof obj.payload === "object" &&
    !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : obj;
  const ocProps =
    harness === "opencode" &&
    ocEnvelope.properties &&
    typeof ocEnvelope.properties === "object" &&
    !Array.isArray(ocEnvelope.properties)
      ? (ocEnvelope.properties as Record<string, unknown>)
      : undefined;
  const ocEnvType = typeof ocEnvelope.type === "string" ? ocEnvelope.type : lineType;
  const ocPropsInfo =
    ocProps?.info && typeof ocProps.info === "object" && !Array.isArray(ocProps.info)
      ? (ocProps.info as Record<string, unknown>)
      : undefined;
  const rawOcPart =
    ocEnvelope.part && typeof ocEnvelope.part === "object"
      ? (ocEnvelope.part as Record<string, unknown>)
      : ocProps?.part && typeof ocProps.part === "object"
        ? (ocProps.part as Record<string, unknown>)
        : undefined;
  const ocSidCandidate =
    harness === "opencode"
      ? (ocEnvelope.sessionID ??
        ocEnvelope.session_id ??
        ocProps?.sessionID ??
        ocProps?.session_id ??
        ocPropsInfo?.id ??
        rawOcPart?.sessionID ??
        rawOcPart?.session_id)
      : undefined;
  const ocSessionId =
    typeof ocSidCandidate === "string" && ocSidCandidate.trim()
      ? ocSidCandidate.trim()
      : undefined;
  const ocSidFields = ocSessionId ? { harnessSessionId: ocSessionId } : {};

  if (harness === "opencode") {
    if (ocEnvType === "server.connected" || ocEnvType === "server.heartbeat") {
      return [];
    }
    if (
      ocEnvType === "message.part.delta" &&
      ocProps &&
      typeof ocProps.delta === "string" &&
      ocProps.delta
    ) {
      const field = typeof ocProps.field === "string" ? ocProps.field : "text";
      if (field === "reasoning" || field === "thinking") {
        events.push({ type: "thinking", harness, thinking: ocProps.delta, ...ocSidFields, timestamp: now });
      } else {
        events.push({ type: "text", harness, text: ocProps.delta, ...ocSidFields, timestamp: now });
      }
      return events;
    }
  }

  const ocPart = rawOcPart ?? ocEnvelope;
  const ocType = typeof ocPart.type === "string" ? ocPart.type : ocEnvType;
  const ocDeltaText =
    harness === "opencode" &&
    ocEnvType === "message.part.updated" &&
    typeof ocProps?.delta === "string" &&
    ocProps.delta
      ? ocProps.delta
      : undefined;

  if (ocType === "reasoning" || ocType === "thinking") {
    const th =
      ocDeltaText ??
      (typeof ocPart.thinking === "string"
        ? ocPart.thinking
        : typeof ocPart.reasoning === "string"
          ? ocPart.reasoning
          : typeof ocPart.text === "string"
            ? ocPart.text
            : "");
    if (th.trim()) {
      events.push({ type: "thinking", harness, thinking: th.trim(), ...ocSidFields, timestamp: now });
      return events;
    }
  }
  if (ocType === "tool" || ocType === "tool_use" || ocType === "tool-invocation") {
    const toolName =
      typeof ocPart.tool === "string"
        ? ocPart.tool
        : typeof ocPart.name === "string"
          ? ocPart.name
          : "tool";
    const toolId =
      typeof ocPart.callID === "string"
        ? ocPart.callID
        : typeof ocPart.id === "string"
          ? ocPart.id
          : undefined;
    const state =
      ocPart.state && typeof ocPart.state === "object"
        ? (ocPart.state as Record<string, unknown>)
        : ocPart;
    const inVal = state.input ?? ocPart.input ?? ocPart.args;
    const outVal = state.output ?? ocPart.output ?? ocPart.result;
    events.push({
      type: "tool_use",
      harness,
      toolName,
      ...(toolId ? { toolId } : {}),
      ...(inVal !== undefined
        ? { toolInput: typeof inVal === "string" ? inVal : JSON.stringify(inVal) }
        : {}),
      ...ocSidFields,
      timestamp: now,
    });
    if (outVal !== undefined && outVal !== null) {
      events.push({
        type: "tool_result",
        harness,
        toolName,
        ...(toolId ? { toolId } : {}),
        toolOutput: typeof outVal === "string" ? outVal : JSON.stringify(outVal),
        ...(state.status === "error" ? { isError: true } : {}),
        ...ocSidFields,
        timestamp: now,
      });
    }
    return events;
  }
  if (harness === "opencode" && ocDeltaText && ocType === "text") {
    events.push({ type: "text", harness, text: ocDeltaText, ...ocSidFields, timestamp: now });
    return events;
  }

  // 3b. Antigravity `--output-format stream-json` events (live-verified 2026-11)
  if (harness === "antigravity") {
    if (obj.event === "step_update") {
      // {"event":"step_update","step_update":{"state":"ACTIVE","step_type":"agent_response","text_delta":"..."}}
      const su =
        obj.step_update && typeof obj.step_update === "object"
          ? (obj.step_update as Record<string, unknown>)
          : undefined;
      const delta =
        su && typeof su.text_delta === "string" ? su.text_delta : "";
      if (delta) {
        events.push({ type: "text", harness, text: delta, timestamp: now });
      }
      return events;
    }
    if (obj.event === "result") {
      const res =
        obj.result && typeof obj.result === "object"
          ? (obj.result as Record<string, unknown>)
          : undefined;
      const response =
        res && typeof res.response === "string" ? res.response : "";
      if (response.trim()) {
        events.push({ type: "text", harness, text: response, timestamp: now });
      }
      return events;
    }
    if (obj.event === "init") {
      return [];
    }
    if (obj.event === "tool_call") {
      const tc =
        obj.tool_call && typeof obj.tool_call === "object"
          ? (obj.tool_call as Record<string, unknown>)
          : undefined;
      const callId =
        typeof obj.call_id === "string"
          ? obj.call_id
          : typeof obj.id === "string"
            ? obj.id
            : undefined;
      const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
      const toolName = tc && typeof tc.name === "string" ? tc.name : "tool";
      const toolInput =
        tc && (tc.args !== undefined || tc.input !== undefined)
          ? typeof tc.args === "string"
            ? tc.args
            : typeof tc.input === "string"
              ? tc.input
              : JSON.stringify(tc.args ?? tc.input)
          : undefined;
      const toolOutput =
        tc && typeof tc.result === "string" ? tc.result : undefined;

      if (subtype === "completed" || toolOutput !== undefined) {
        events.push({
          type: "tool_result",
          harness,
          toolName,
          ...(callId ? { toolId: callId } : {}),
          ...(toolOutput !== undefined ? { toolOutput } : {}),
          timestamp: now,
        });
        return events;
      }

      events.push({
        type: "tool_use",
        harness,
        toolName,
        ...(callId ? { toolId: callId } : {}),
        ...(toolInput !== undefined ? { toolInput } : {}),
        timestamp: now,
      });
      return events;
    }
  }

  // 4. Antigravity PLANNER_RESPONSE / TOOL_RESPONSE
  if (lineType === "PLANNER_RESPONSE") {
    if (typeof obj.thinking === "string" && obj.thinking.trim()) {
      events.push({ type: "thinking", harness, thinking: obj.thinking.trim(), timestamp: now });
    }
    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const t = tc as Record<string, unknown>;
        const toolName = typeof t.name === "string" ? t.name : "tool";
        const toolId = typeof t.id === "string" ? t.id : undefined;
        const inVal = t.args ?? t.arguments ?? t.input;
        events.push({
          type: "tool_use",
          harness,
          toolName,
          ...(toolId ? { toolId } : {}),
          ...(inVal !== undefined
            ? { toolInput: typeof inVal === "string" ? inVal : JSON.stringify(inVal) }
            : {}),
          timestamp: now,
        });
      }
    }
    if (typeof obj.content === "string" && obj.content.trim()) {
      events.push({ type: "text", harness, text: obj.content, timestamp: now });
    }
    if (events.length > 0) return events;
  }
  const isAntigravityToolResponse =
    lineType === "TOOL_RESPONSE" ||
    lineType === "GENERIC" ||
    ((String(obj.source) === "MODEL" || String(obj.source) === "SYSTEM") &&
      lineType !== "PLANNER_RESPONSE" &&
      lineType !== "USER_INPUT" &&
      (typeof obj.content === "string" || typeof obj.error === "string"));

  if (isAntigravityToolResponse) {
    const rawOut = obj.content ?? obj.error ?? obj.output ?? "";
    const out = typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut);
    if (!out.trim() && !obj.tool_name) return [];
    events.push({
      type: "tool_result",
      harness,
      ...(typeof obj.tool_name === "string" ? { toolName: obj.tool_name } : {}),
      ...(typeof obj.name === "string" ? { toolName: obj.name } : {}),
      ...(typeof obj.tool_call_id === "string" ? { toolId: obj.tool_call_id } : {}),
      ...(typeof obj.id === "string" ? { toolId: obj.id } : {}),
      toolOutput: out,
      ...(obj.status === "ERROR" || Boolean(obj.error) || obj.is_error === true ? { isError: true } : {}),
      timestamp: now,
    });
    return events;
  }

  // 5. Generic text fallback
  const fallbackText =
    typeof ocPart.text === "string"
      ? ocPart.text
      : typeof obj.text === "string"
        ? obj.text
        : typeof obj.content === "string"
          ? obj.content
          : "";
  if (fallbackText.trim()) {
    events.push({ type: "text", harness, text: fallbackText, ...ocSidFields, timestamp: now });
    return events;
  }

  if (
    harness === "opencode" &&
    ocSessionId &&
    (ocEnvType === "session.created" ||
      ocEnvType === "session.updated" ||
      ocEnvType === "session.status" ||
      ocEnvType === "session.idle")
  ) {
    events.push({
      type: "status",
      harness,
      harnessSessionId: ocSessionId,
      timestamp: now,
    });
    return events;
  }

  if (lineType === "status" && typeof obj.session_id === "string" && obj.session_id) {
    events.push({
      type: "status",
      harness,
      harnessSessionId: obj.session_id,
      timestamp: now,
    });
    return events;
  }

  return [];
}

export interface DriverSessionPoolEntry {
  key: string;
  projectRoot: string;
  sessionId: string;
  driverId: string;
  harness: HarnessId;
  model: string;
  launchArgs: string[];
  client: AcpStdioClient;
  acpSessionId: string;
}

const driverSessionPool = new Map<string, DriverSessionPoolEntry>();
const activeAcpTurnCancels = new Map<string, Set<() => void>>();

function buildDriverPoolKey(
  projectRoot: string,
  sessionId: string,
  driverId: string
): string {
  return `${projectRoot.toLowerCase()}::${sessionId}::${driverId}`;
}

export function cancelDriverTurn(sessionId: string): boolean {
  const fns = activeAcpTurnCancels.get(sessionId);
  if (!fns || fns.size === 0) return false;
  for (const fn of [...fns]) {
    fn();
  }
  return true;
}

export async function closeDriverSessionByDriverId(driverId: string): Promise<void> {
  const matches: DriverSessionPoolEntry[] = [];
  for (const [key, entry] of driverSessionPool.entries()) {
    if (entry.driverId === driverId) {
      driverSessionPool.delete(key);
      matches.push(entry);
    }
  }
  await Promise.all(matches.map((entry) => entry.client.close().catch(() => {})));
}

export async function closeDriverSession(sessionId: string): Promise<void> {
  const matches: DriverSessionPoolEntry[] = [];
  for (const [key, entry] of driverSessionPool.entries()) {
    if (entry.sessionId === sessionId) {
      driverSessionPool.delete(key);
      matches.push(entry);
    }
  }
  await Promise.all(matches.map((entry) => entry.client.close().catch(() => {})));
}

export async function closeAllDriverSessions(): Promise<void> {
  const all = [...driverSessionPool.values()];
  driverSessionPool.clear();
  await Promise.all(all.map((entry) => entry.client.close().catch(() => {})));
}

function selectDriverPermissionOption(
  options: AcpPermissionOption[],
  allow: boolean
): AcpRequestPermissionResult {
  if (!Array.isArray(options) || options.length === 0) {
    return { outcome: { outcome: "cancelled" } };
  }
  if (allow) {
    const picked =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => o.kind === "allow_always") ??
      options.find((o) =>
        /allow|approve|accept|yes/i.test(`${o.optionId} ${o.kind} ${o.name}`)
      ) ??
      options[0];
    if (picked) {
      return { outcome: { outcome: "selected", optionId: picked.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }
  const rejectPicked =
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => o.kind === "reject_always") ??
    options.find((o) =>
      /reject|deny|block|cancel|no/i.test(`${o.optionId} ${o.kind} ${o.name}`)
    );
  if (rejectPicked) {
    return { outcome: { outcome: "selected", optionId: rejectPicked.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function mapAcpEventToDriverEvent(
  ev: AcpNormalizedEvent,
  harness: HarnessId,
  acpSessionId: string
): DriverStreamEvent | null {
  switch (ev.category) {
    case "text":
      return {
        type: "text",
        harness,
        ...(ev.text !== undefined ? { text: ev.text } : {}),
        harnessSessionId: acpSessionId,
        timestamp: ev.timestamp,
      };
    case "thinking":
      return {
        type: "thinking",
        harness,
        ...(ev.thinking !== undefined ? { thinking: ev.thinking } : {}),
        harnessSessionId: acpSessionId,
        timestamp: ev.timestamp,
      };
    case "tool_use":
      return {
        type: "tool_use",
        harness,
        ...(ev.toolName !== undefined ? { toolName: ev.toolName } : {}),
        ...(ev.toolCallId !== undefined ? { toolId: ev.toolCallId } : {}),
        ...(ev.toolInput !== undefined ? { toolInput: ev.toolInput } : {}),
        harnessSessionId: acpSessionId,
        timestamp: ev.timestamp,
      };
    case "tool_result":
      return {
        type: "tool_result",
        harness,
        ...(ev.toolName !== undefined ? { toolName: ev.toolName } : {}),
        ...(ev.toolCallId !== undefined ? { toolId: ev.toolCallId } : {}),
        ...(ev.toolOutput !== undefined ? { toolOutput: ev.toolOutput } : {}),
        ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
        harnessSessionId: acpSessionId,
        timestamp: ev.timestamp,
      };
    case "state":
    case "permission":
      return null;
  }
}

export interface RunDriverTurnInput {
  projectRoot: string;
  homeDir?: string;
  db: SqliteDriver;
  sessionId: string;
  prompt: string;
  driverId?: string;
  injectBriefing?: "auto" | "always" | "never";
  timeoutMs?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  onEvent?: (event: DriverStreamEvent) => void;
  streamJson?: boolean;
  commandRunner?: CommandRunner;
  model?: string | null;
  transport?: "auto" | "acp" | "cli";
  autoApprove?: boolean;
  onPermissionRequest?: (
    params: AcpRequestPermissionParams
  ) => Promise<AcpRequestPermissionResult>;
  acpCommandOverride?: { command: string; args: string[] };
  openCodeProfile?: OpenCodeCapabilityProfile;
  openCodeServerUrl?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export async function runDriverTurn(
  input: RunDriverTurnInput
): Promise<DriverRunResult> {
  if (!isValidAsdSessionId(input.sessionId)) {
    throw new Error("INVALID_SESSION_ID");
  }

  const projectRoot = path.resolve(input.projectRoot);
  const driver = input.driverId
    ? input.db.getDriver(input.driverId)
    : input.db.getActiveDriver(input.sessionId);

  if (
    !driver ||
    driver.session_id !== input.sessionId ||
    driver.detached_at !== null
  ) {
    throw new Error("NO_ACTIVE_DRIVER");
  }

  const busyKey = `${projectRoot.toLowerCase()}::${driver.driver_id}`;
  if (activeDriverRuns.has(busyKey)) {
    throw new Error("DRIVER_BUSY");
  }

  const runsBaseDir = path.join(
    projectRoot,
    ".asd",
    "sessions",
    input.sessionId,
    "drivers",
    driver.driver_id,
    "runs"
  );
  if (fs.existsSync(runsBaseDir)) {
    try {
      for (const entry of fs.readdirSync(runsBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const mPath = path.join(runsBaseDir, entry.name, "meta.json");
        if (!fs.existsSync(mPath)) continue;
        const parsed = JSON.parse(fs.readFileSync(mPath, "utf8")) as {
          status?: string;
          pid?: number;
        };
        if (
          parsed.status === "running" &&
          typeof parsed.pid === "number" &&
          parsed.pid > 0 &&
          isPidAlive(parsed.pid)
        ) {
          throw new Error("DRIVER_BUSY");
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === "DRIVER_BUSY") {
        throw err;
      }
    }
  }

  activeDriverRuns.add(busyKey);
  try {
    const injectMode = input.injectBriefing ?? "auto";
    let shouldInject = false;
    if (injectMode === "always") {
      shouldInject = true;
    } else if (injectMode === "auto" && driver.briefing_injected === 0) {
      const allDrivers = input.db.listDrivers(input.sessionId);
      const hasPrevDriver = allDrivers.some(
        (d) => d.driver_id !== driver.driver_id
      );
      const hasTasks = input.db.getSessionTasks(input.sessionId).length >= 1;
      if (hasPrevDriver || hasTasks) {
        shouldInject = true;
      }
    }

    let effectivePrompt = input.prompt;
    if (shouldInject) {
      const briefing = buildDriverBriefing({
        db: input.db,
        projectRoot,
        sessionId: input.sessionId,
      });
      effectivePrompt = `${briefing}\n\n---\n\n${input.prompt}`;
    }

    const harnessId = driver.harness as HarnessId;
    const effectiveAutoApprove =
      input.autoApprove ??
      (input.db.getSession(input.sessionId)?.auto_approve !== 0);
    const effectiveTransport =
      input.transport ?? (input.commandRunner ? "cli" : "auto");
    const effectiveModel =
      input.model?.trim() ||
      driver.model?.trim() ||
      getDefaultModelForHarness(harnessId);

    const baseEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(input.env ?? {}),
    };
    const env: Record<string, string | undefined> = {
      ...baseEnv,
      ASD_SESSION_ROLE: "driver",
      ASD_MAIN_SESSION_ID: input.sessionId,
      ASD_DRIVER_ID: driver.driver_id,
      NODE_NO_WARNINGS: "1",
    };

    const openCodeProfile =
      harnessId === "opencode"
        ? (input.openCodeProfile ?? resolveOpenCodeCapabilityProfile({ env: baseEnv }))
        : undefined;

    const readiness =
      effectiveTransport !== "cli"
        ? input.acpCommandOverride
          ? {
              supported: true as const,
              command: input.acpCommandOverride.command,
              args: input.acpCommandOverride.args,
            }
          : probeAcpCapability(harnessId, baseEnv, {
              interactivePermissions: !effectiveAutoApprove,
              ...(openCodeProfile ? { openCodeProfile } : {}),
            })
        : { supported: false as const, command: "", args: [] as string[] };

    if (effectiveTransport === "acp" && !readiness.supported) {
      throw new Error(
        `ACP_UNAVAILABLE: ACP server not available for harness '${harnessId}'`
      );
    }

    const runId = generateDriverRunId();
    const runDir = path.join(runsBaseDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const metaPath = path.join(runDir, "meta.json");
    const logPath = path.join(runDir, "output.log");

    const startedAt = Date.now();
    let currentSid: string | null = driver.harness_session_id ?? null;
    let meta: Record<string, unknown> = {
      runId,
      sessionId: input.sessionId,
      driverId: driver.driver_id,
      harness: driver.harness,
      model: effectiveModel,
      harnessSessionId: currentSid,
      pid: 0,
      status: "running",
      startedAt,
    };
    const writeMeta = (): void => {
      atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    };
    writeMeta();

    const recordDetectedSid = (extracted: string): void => {
      if (!extracted) return;
      if (!currentSid || currentSid !== extracted) {
        try {
          const updated = setDriverHarnessSessionId(input.db, {
            projectRoot,
            driverId: driver.driver_id,
            harnessSessionId: extracted,
            allowOverwrite: true,
          });
          currentSid = updated.harness_session_id ?? extracted;
        } catch {
          const fresh = input.db.getDriver(driver.driver_id);
          currentSid = fresh?.harness_session_id ?? extracted;
        }
      }
      meta = { ...meta, harnessSessionId: currentSid };
      writeMeta();
    };

    let skipAcpAfterServerFailure = false;
    if (
      harnessId === "opencode" &&
      input.openCodeServerUrl &&
      effectiveTransport !== "acp"
    ) {
      const sseController = new AbortController();
      const onExternalSseAbort = (): void => {
        sseController.abort();
        if (currentSid) {
          void abortOpenCodeServerSession({
            serverUrl: input.openCodeServerUrl!,
            sessionId: currentSid,
            env: baseEnv,
            profile: openCodeProfile,
            fetchImpl: input.fetchImpl,
          });
        }
      };
      if (input.signal) {
        input.signal.addEventListener("abort", onExternalSseAbort, { once: true });
        if (input.signal.aborted) {
          onExternalSseAbort();
        }
      }

      const sseRes = await streamOpenCodeServerEvents({
        serverUrl: input.openCodeServerUrl,
        env: baseEnv,
        profile: openCodeProfile,
        signal: sseController.signal,
        fetchImpl: input.fetchImpl,
        onRawChunk: (chunk) => input.onOutput?.(chunk),
        onEvent: (ev) => {
          if (ev.harnessSessionId) {
            recordDetectedSid(ev.harnessSessionId);
          }
          input.onEvent?.(ev);
        },
      });

      if (input.signal) {
        input.signal.removeEventListener("abort", onExternalSseAbort);
      }

      if (sseRes.ok && !input.signal?.aborted) {
        if (shouldInject) {
          input.db.markDriverBriefingInjected(driver.driver_id);
        }
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        meta = {
          ...meta,
          exitCode: 0,
          timedOut: false,
          harnessSessionId: currentSid,
          status: "done",
          transport: "daemon-sse",
          eventUrl: sseRes.url,
          startedAt,
          finishedAt,
          durationMs,
        };
        writeMeta();
        pruneDriverRuns(runsBaseDir, 50);
        return {
          runId,
          driverId: driver.driver_id,
          exitCode: 0,
          timedOut: false,
          harnessSessionId: currentSid,
          durationMs,
          metaPath,
        };
      }

      if (input.signal?.aborted) {
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        meta = {
          ...meta,
          exitCode: -1,
          timedOut: false,
          harnessSessionId: currentSid,
          status: "failed",
          transport: "daemon-sse",
          eventUrl: sseRes.url,
          startedAt,
          finishedAt,
          durationMs,
        };
        writeMeta();
        pruneDriverRuns(runsBaseDir, 50);
        return {
          runId,
          driverId: driver.driver_id,
          exitCode: -1,
          timedOut: false,
          harnessSessionId: currentSid,
          durationMs,
          metaPath,
        };
      }

      skipAcpAfterServerFailure = true;
    }

    if (
      !skipAcpAfterServerFailure &&
      effectiveTransport !== "cli" &&
      readiness.supported
    ) {
      const poolKey = buildDriverPoolKey(
        projectRoot,
        input.sessionId,
        driver.driver_id
      );
      let activeEntry = driverSessionPool.get(poolKey);
      if (activeEntry) {
        const reusable =
          activeEntry.client.isConnected &&
          JSON.stringify(activeEntry.launchArgs) ===
            JSON.stringify(readiness.args);
        if (!reusable) {
          driverSessionPool.delete(poolKey);
          await activeEntry.client.close().catch(() => {});
          activeEntry = undefined;
        }
      }

      let spawnedFreshClient: AcpStdioClient | null = null;
      let phaseAAborted = false;
      const onPhaseASignalAbort = (): void => {
        phaseAAborted = true;
        if (spawnedFreshClient) {
          void spawnedFreshClient.close().catch(() => {});
        }
        if (activeEntry) {
          void activeEntry.client.close().catch(() => {});
        }
      };
      if (input.signal) {
        input.signal.addEventListener("abort", onPhaseASignalAbort, {
          once: true,
        });
        if (input.signal.aborted) {
          phaseAAborted = true;
        }
      }

      try {
        if (phaseAAborted) {
          throw new Error("ACP_TURN_ABORTED");
        }
        if (!activeEntry) {
          const client = new AcpStdioClient({
            command: readiness.command,
            args: readiness.args,
            cwd: projectRoot,
            env,
            onSpawn: (pid) => {
              meta = { ...meta, pid };
              writeMeta();
            },
          });
          spawnedFreshClient = client;
          await client.connect();
          const sess = await client.startOrLoadSession({
            cwd: projectRoot,
            resumeSessionId: driver.harness_session_id,
            model: effectiveModel,
          });
          activeEntry = {
            key: poolKey,
            projectRoot,
            sessionId: input.sessionId,
            driverId: driver.driver_id,
            harness: harnessId,
            model: effectiveModel,
            launchArgs: [...readiness.args],
            client,
            acpSessionId: sess.sessionId,
          };
          driverSessionPool.set(poolKey, activeEntry);
          spawnedFreshClient = null;
        } else if ((activeEntry.model ?? "") !== effectiveModel) {
          await activeEntry.client.setSessionModel(
            activeEntry.acpSessionId,
            effectiveModel
          );
          activeEntry.model = effectiveModel;
        }
      } catch (phaseAErr) {
        if (spawnedFreshClient) {
          await spawnedFreshClient.close().catch(() => {});
        }
        if (activeEntry) {
          driverSessionPool.delete(poolKey);
          await activeEntry.client.close().catch(() => {});
          activeEntry = undefined;
        }
        if (phaseAAborted) {
          const finishedAt = Date.now();
          const durationMs = finishedAt - startedAt;
          meta = {
            ...meta,
            exitCode: -1,
            timedOut: false,
            status: "failed",
            startedAt,
            finishedAt,
            durationMs,
            transport: "acp",
          };
          writeMeta();
          pruneDriverRuns(runsBaseDir, 50);
          return {
            runId,
            driverId: driver.driver_id,
            exitCode: -1,
            timedOut: false,
            harnessSessionId: currentSid,
            durationMs,
            metaPath,
          };
        }
        if (effectiveTransport === "acp") {
          const finishedAt = Date.now();
          const durationMs = finishedAt - startedAt;
          meta = {
            ...meta,
            exitCode: -1,
            timedOut: false,
            status: "failed",
            startedAt,
            finishedAt,
            durationMs,
            transport: "acp",
          };
          writeMeta();
          throw phaseAErr;
        }
        // effectiveTransport === "auto": fall through to CLI path below
        activeEntry = undefined;
      } finally {
        if (input.signal) {
          input.signal.removeEventListener("abort", onPhaseASignalAbort);
        }
      }

      if (activeEntry) {
        recordDetectedSid(activeEntry.acpSessionId);
        meta = {
          ...meta,
          pid: activeEntry.client.pid,
          harnessSessionId: currentSid ?? activeEntry.acpSessionId,
          transport: "acp",
        };
        writeMeta();
        input.onEvent?.({
          type: "status",
          harness: harnessId,
          harnessSessionId: activeEntry.acpSessionId,
          timestamp: Date.now(),
        });

        if (shouldInject) {
          input.db.markDriverBriefingInjected(driver.driver_id);
        }

        const baseWallMs =
          input.timeoutMs !== undefined && input.maxDurationMs !== undefined
            ? Math.min(input.timeoutMs, input.maxDurationMs)
            : (input.timeoutMs ?? input.maxDurationMs);

        let cancelTriggered = false;
        let cancelledByCaller = false;
        let timedOut = false;
        let graceExpired = false;
        let wallTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let rejectGrace: ((err: Error) => void) | null = null;

        const gracePromise = new Promise<never>((_, reject) => {
          rejectGrace = reject;
        });

        const triggerCancel = (isTimeout: boolean): void => {
          if (cancelTriggered) return;
          cancelTriggered = true;
          if (isTimeout) {
            timedOut = true;
          } else {
            cancelledByCaller = true;
          }
          activeEntry!.client.cancelSession(activeEntry!.acpSessionId);
          graceTimer = setTimeout(() => {
            graceExpired = true;
            rejectGrace?.(new Error("ACP_CANCEL_GRACE_EXPIRED"));
          }, 1500);
          graceTimer.unref?.();
        };

        const resetIdleTimer = (): void => {
          if (input.idleTimeoutMs === undefined || cancelTriggered) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => triggerCancel(true),
            input.idleTimeoutMs
          );
          idleTimer.unref?.();
        };

        const cancelFn = (): void => triggerCancel(false);
        let cancelSet = activeAcpTurnCancels.get(input.sessionId);
        if (!cancelSet) {
          cancelSet = new Set();
          activeAcpTurnCancels.set(input.sessionId, cancelSet);
        }
        cancelSet.add(cancelFn);

        const onSignalAbort = (): void => triggerCancel(false);
        if (input.signal) {
          input.signal.addEventListener("abort", onSignalAbort, { once: true });
        }

        if (baseWallMs !== undefined) {
          wallTimer = setTimeout(() => triggerCancel(true), baseWallMs);
          wallTimer.unref?.();
        }
        resetIdleTimer();

        activeEntry.client.setTurnHandlers({
          onEvent: (ev) => {
            resetIdleTimer();
            const mapped = mapAcpEventToDriverEvent(
              ev,
              harnessId,
              activeEntry!.acpSessionId
            );
            if (mapped) {
              input.onEvent?.(mapped);
            }
          },
          onRawFrame: () => {
            resetIdleTimer();
          },
          onPermissionRequest: async (params) => {
            resetIdleTimer();
            if (effectiveAutoApprove) {
              return selectDriverPermissionOption(params.options ?? [], true);
            }
            if (input.onPermissionRequest) {
              return await input.onPermissionRequest(params);
            }
            return selectDriverPermissionOption(params.options ?? [], false);
          },
        });

        let exitCode = 0;
        let shouldCloseClient = false;
        const capturedPid = activeEntry.client.pid;

        try {
          if (input.signal?.aborted) {
            cancelledByCaller = true;
            exitCode = -1;
          } else {
            const promptPromise = activeEntry.client.promptTurn(
              activeEntry.acpSessionId,
              effectivePrompt
            );
            promptPromise.catch(() => {});
            const turnRes = await Promise.race([promptPromise, gracePromise]);
            if (timedOut || cancelledByCaller) {
              exitCode = -1;
            } else if (
              turnRes.stopReason === "cancelled" ||
              turnRes.stopReason === "refusal"
            ) {
              exitCode = 1;
            } else {
              exitCode = 0;
            }
          }
        } catch {
          exitCode = -1;
          shouldCloseClient = true;
        } finally {
          if (wallTimer) clearTimeout(wallTimer);
          if (idleTimer) clearTimeout(idleTimer);
          if (graceTimer) clearTimeout(graceTimer);
          if (input.signal) {
            input.signal.removeEventListener("abort", onSignalAbort);
          }
          const set = activeAcpTurnCancels.get(input.sessionId);
          if (set) {
            set.delete(cancelFn);
            if (set.size === 0) {
              activeAcpTurnCancels.delete(input.sessionId);
            }
          }
          activeEntry.client.setTurnHandlers({});
          if (
            shouldCloseClient ||
            graceExpired ||
            !activeEntry.client.isConnected
          ) {
            driverSessionPool.delete(poolKey);
            await activeEntry.client.close().catch(() => {});
          }
        }

        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const finalSid = currentSid ?? activeEntry.acpSessionId ?? null;
        meta = {
          ...meta,
          pid: capturedPid || activeEntry.client.pid,
          exitCode,
          timedOut,
          harnessSessionId: finalSid,
          status: exitCode === 0 ? "done" : "failed",
          startedAt,
          finishedAt,
          durationMs,
        };
        writeMeta();
        pruneDriverRuns(runsBaseDir, 50);

        return {
          runId,
          driverId: driver.driver_id,
          exitCode,
          timedOut,
          harnessSessionId: finalSid,
          durationMs,
          metaPath,
        };
      }
    }

    // CLI path (explicit transport: "cli", commandRunner override, or "auto" fallback)
    const useStreamJson =
      input.streamJson ??
      (Boolean(input.openCodeServerUrl) ||
        Boolean(input.onEvent && !input.commandRunner));

    const spawnSpec = buildSpawnSpec({
      harness: harnessId,
      prompt: effectivePrompt,
      model: driver.harness_session_id
        ? (input.model?.trim() || driver.model || effectiveModel)
        : effectiveModel,
      streaming: useStreamJson,
      resumeSessionId: driver.harness_session_id ?? undefined,
      ...(harnessId === "opencode" && openCodeProfile
        ? { pure: openCodeProfile.effectiveProfile !== "v2" }
        : {}),
    });
    const command = spawnSpec.command;
    const args =
      harnessId === "opencode" && openCodeProfile
        ? applyOpenCodeHeadlessFlags(spawnSpec.args, openCodeProfile)
        : spawnSpec.args;

    const streamParser = createStreamParser({
      harness: harnessId,
      sessionId: input.sessionId,
    });
    const handleOutputChunk = (chunk: string): void => {
      input.onOutput?.(chunk);
      for (const ev of streamParser.pushChunk(chunk)) {
        if (ev.harnessSessionId) {
          recordDetectedSid(ev.harnessSessionId);
        }
        input.onEvent?.(ev);
      }
    };

    if (shouldInject) {
      input.db.markDriverBriefingInjected(driver.driver_id);
    }

    const execRes = await executeHarnessProcess({
      command,
      args,
      cwd: projectRoot,
      env,
      harness: harnessId,
      initialHarnessSessionId: currentSid,
      logPath,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      maxDurationMs: input.maxDurationMs,
      idleTimeoutMs: input.idleTimeoutMs,
      commandRunner: input.commandRunner,
      stdinPayload: spawnSpec.stdinPayload,
      closeStdinOnSpawn: spawnSpec.closeStdinOnSpawn ?? true,
      onOutput: handleOutputChunk,
      onSpawn: (pid) => {
        meta = { ...meta, pid };
        writeMeta();
      },
      onSessionIdDetected: (extracted) => {
        recordDetectedSid(extracted);
      },
      onBeforeStreamEnd: (res) => {
        for (const ev of streamParser.flush()) {
          if (ev.harnessSessionId) {
            recordDetectedSid(ev.harnessSessionId);
          }
          input.onEvent?.(ev);
        }
        if (res.harnessSessionId && !currentSid) {
          recordDetectedSid(res.harnessSessionId);
        }
        meta = {
          ...meta,
          pid: res.pid,
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          harnessSessionId: currentSid ?? res.harnessSessionId ?? null,
          status: res.status,
          startedAt: res.startedAt,
          finishedAt: res.finishedAt,
          durationMs: res.durationMs,
        };
        writeMeta();
      },
    });

    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    } catch {
      // best-effort
    }

    pruneDriverRuns(runsBaseDir, 50);

    return {
      runId,
      driverId: driver.driver_id,
      exitCode: execRes.exitCode,
      timedOut: execRes.timedOut,
      harnessSessionId: currentSid ?? execRes.harnessSessionId ?? null,
      durationMs: execRes.durationMs,
      metaPath,
    };
  } finally {
    activeDriverRuns.delete(busyKey);
  }
}
