/**
 * ASD Session Services (src/core/session-services.ts)
 *
 * Pure data services for session memo management and dashboard state snapshots.
 * No UI/server dependencies.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadRoutingConfig, resolveAsdPaths } from "./config.ts";
import {
  type DebateRow,
  type DriverRow,
  openProjectDb,
  type SessionRow,
  SqliteDriver,
  type TaskRow,
} from "./db.ts";
import {
  detectSystemLocale,
  discoverHarnessModels,
  type HarnessModelCatalog,
} from "./models.ts";
import { atomicWriteFileSync } from "./render.ts";
import { readCliRecentSessions } from "./session-tracker.ts";
import { scanSubagentLogs, type SubagentLogRecord } from "./subagent-logs.ts";
import {
  ASD_VERSION,
  getCoreInstallerHooks,
  type CliRecentSessionEntry,
  type RoutingConfig,
} from "./types.ts";

export type { HarnessModelCatalog };

export interface DashboardSnapshot {
  version: string;
  projectRoot: string;
  systemLocale: string;
  timestamp: number;
  session: SessionRow | null;
  sessions: SessionRow[];
  tasks: TaskRow[];
  allTasks: TaskRow[];
  debates: DebateRow[];
  allDebates: DebateRow[];
  drivers: Record<string, DriverRow[]>;
  subagentLogs: SubagentLogRecord[];
  cliRecentSessions?: CliRecentSessionEntry[];
  routingConfig: RoutingConfig;
  hasLocalRouting: boolean;
  localRoutingPath: string;
  availableModels: HarnessModelCatalog;
  worktreeStatuses?: Record<string, string[]>;
  harnesses?: Record<
    string,
    {
      installed: boolean;
      headlessSupported: boolean;
      binary?: string;
      resolvedPath?: string | null;
    }
  >;
}

export type DashboardStateSnapshot = DashboardSnapshot;

export function buildPromptForTask(
  task: TaskRow,
  upstreamDecisions: string[] = [],
  upstreamFiles: string[] = []
): string {
  let targetFiles: string[] = [];
  try {
    targetFiles = JSON.parse(task.target_files_json || "[]");
  } catch {
    targetFiles = [];
  }

  const lines: string[] = [
    `# ASD Subagent Task: ${task.task_id}`,
    `Title: ${task.title}`,
    `Track: ${task.track}`,
    `Role: ${task.role}`,
    `Category: ${task.category}`,
    `Difficulty: ${task.difficulty}`,
    "",
    "## Allowed Target Files",
    targetFiles.length > 0 ? targetFiles.map((f) => `- ${f}`).join("\n") : "- None specified",
    "",
  ];

  if (task.context_hint) {
    lines.push("## Context Hint", task.context_hint, "");
  }

  if (task.acceptance) {
    lines.push("## Acceptance Criteria", task.acceptance, "");
  }

  if (upstreamDecisions.length > 0) {
    lines.push("## Upstream Key Decisions", upstreamDecisions.map((d) => `- ${d}`).join("\n"), "");
  }

  if (upstreamFiles.length > 0) {
    lines.push("## Upstream Changed Files", upstreamFiles.map((f) => `- ${f}`).join("\n"), "");
  }

  lines.push(
    "## Operational Guidelines",
    "1. Modify ONLY the files listed under Allowed Target Files (plus test files under tests/ or *.test.ts when needed to keep tests passing).",
    "2. Ensure implementation satisfies the acceptance criteria.",
    "3. Run automated tests and ensure zero errors.",
    "4. If you discover that a file OUTSIDE Allowed Target Files (e.g., owned by another harness/task) MUST be modified, DO NOT modify it directly (it will be blocked). Instead, complete your work within Allowed Target Files and emit an `asd-report` JSON block at the very end of your response:",
    "```asd-report",
    "{",
    '  "summary": "Brief summary of completed work",',
    '  "key_decisions": ["Key decision 1"],',
    '  "risks": ["Any remaining risk"],',
    '  "cross_scope_requests": [',
    "    {",
    '      "target_file": "path/to/other-harness-file.ts",',
    '      "caller_files": ["path/to/your-own-file-to-bundle.ts"],',
    '      "reason": "Why the external file needs modification",',
    '      "suggested_change": "Exact interface/function change needed"',
    "    }",
    "  ]",
    "}",
    "```",
    "(Up to 2 cross_scope_requests per task are automatically scheduled into the next Turn with your caller_files bundled; any additional requests beyond 2 are forwarded to the Main Director Agent for review.)"
  );

  return lines.join("\n");
}

const doctorCache = new Map<string, DashboardSnapshot["harnesses"]>();

const worktreeStatusCache = new Map<
  string,
  { lines: string[]; expiresAt: number }
>();
const WORKTREE_STATUS_CACHE_TTL_MS = 3500;

const transcriptSyncThrottleCache = new Map<string, number>();
export const TRANSCRIPT_SYNC_THROTTLE_MS = 15_000;

export function resetDashboardTranscriptSyncThrottle(): void {
  transcriptSyncThrottleCache.clear();
}

function readMainJsonMeta(projectRoot: string, sessionId: string): Record<string, unknown> | null {
  try {
    const mainJsonPath = path.join(projectRoot, ".asd", "sessions", sessionId, "main.json");
    if (!fs.existsSync(mainJsonPath)) return null;
    return JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function saveSessionMemo(options: {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  memo: string;
}): { ok: boolean; sessionId: string; memo: string } {
  const projectRoot = path.resolve(options.projectRoot);
  const sessionId = options.sessionId.trim();
  const memo = options.memo.trim().slice(0, 80);

  if (!sessionId || /[\\/]|\.\./.test(sessionId)) {
    throw new Error("Invalid sessionId");
  }

  // Handle virtual standalone debate session IDs (`<realSessionId>::<debateId>`)
  const virtualSplitIdx = sessionId.indexOf("::");
  const realSessionId =
    virtualSplitIdx !== -1 ? sessionId.slice(0, virtualSplitIdx) : sessionId;

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, options.homeDir);
    const existing = db.getSession(realSessionId);
    if (!existing) {
      db.createOrGetSession({
        sessionId: realSessionId,
        projectRoot,
        mainHarness: "claude-code",
        memo,
      });
    } else if (virtualSplitIdx === -1) {
      db.updateSessionMemo(realSessionId, memo);
    }
  } finally {
    db?.close();
  }

  // Persist memo inside .asd/sessions/<realSessionId>/main.json (including per-debate memos map)
  try {
    const sessionDir = path.join(projectRoot, ".asd", "sessions", realSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const mainJsonPath = path.join(sessionDir, "main.json");
    const current = readMainJsonMeta(projectRoot, realSessionId) ?? {
      sessionId: realSessionId,
      roleType: "main",
      harness: "claude-code",
      role: "director",
      phase: "planning",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    if (virtualSplitIdx !== -1) {
      const debateId = sessionId.slice(virtualSplitIdx + 2);
      const debateMemos =
        current.debateMemos && typeof current.debateMemos === "object"
          ? (current.debateMemos as Record<string, string>)
          : {};
      debateMemos[debateId] = memo;
      current.debateMemos = debateMemos;
    } else {
      current.memo = memo;
    }
    atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
  } catch {
    // Ignore file sync error if SQLite succeeded
  }

  return { ok: true, sessionId, memo };
}

export async function collectDashboardSnapshot(options?: {
  projectRoot?: string;
  homeDir?: string;
  skipCliSpawn?: boolean;
  syncLocalTranscripts?: boolean;
  transcriptSyncThrottleMs?: number;
}): Promise<DashboardSnapshot> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const paths = resolveAsdPaths(projectRoot, homeDir);

  let rawSessions: SessionRow[] = [];
  let allTasks: TaskRow[] = [];
  let rawDebates: DebateRow[] = [];
  const drivers: Record<string, DriverRow[]> = {};

  if (fs.existsSync(paths.dbPath)) {
    let db: SqliteDriver | undefined;
    try {
      db = openProjectDb(projectRoot, homeDir);
      rawSessions = db.listSessions();
      allTasks = db.getAllTasks();
      rawDebates = db.getAllDebates();
      for (const s of rawSessions) {
        drivers[s.session_id] = db.listDrivers(s.session_id);
      }
    } catch {
      // Ignore transient read issues
    } finally {
      db?.close();
    }
  }

  const rawSubagentLogs = scanSubagentLogs(projectRoot);

  // Backfill missing taskId on legacy debate subagent logs (`...-deb-<debateId>-r1-1`)
  const subagentLogs: SubagentLogRecord[] = rawSubagentLogs.map((l) => {
    const debMatch = l.subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
    const inferredTaskId = l.taskId || debMatch?.[1] || "";
    return {
      ...l,
      taskId: inferredTaskId,
    };
  });

  // Split sessions that have multiple standalone (task_id === null) debates into
  // separate virtual session rows (`<sessionId>::<debateId>`) so historical debates
  // that were accidentally grouped under one session appear as individual entries.
  const sessionMap = new Map<string, SessionRow>();
  const allDebates: DebateRow[] = [];

  for (const s of rawSessions) {
    const mainMeta = readMainJsonMeta(projectRoot, s.session_id);
    const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
    const debateMemos =
      mainMeta?.debateMemos && typeof mainMeta.debateMemos === "object"
        ? (mainMeta.debateMemos as Record<string, string>)
        : {};

    const sTasks = allTasks.filter((t) => t.session_id === s.session_id);
    const sDebates = rawDebates.filter((d) => d.session_id === s.session_id);
    const standaloneDebates = sDebates.filter((d) => !d.task_id);

    if (sTasks.length === 0 && standaloneDebates.length > 1) {
      // Split each standalone debate into its own selectable session entry
      for (const d of standaloneDebates) {
        const virtualId = `${s.session_id}::${d.debate_id}`;
        const relatedLogs = subagentLogs.filter(
          (l) =>
            l.sessionId === s.session_id &&
            (l.taskId === d.debate_id || l.subSessionId.includes(`-deb-${d.debate_id}-`))
        );
        for (const rl of relatedLogs) {
          rl.sessionId = virtualId;
        }
        const startedTime =
          relatedLogs.length > 0
            ? Math.min(...relatedLogs.map((r) => r.startedAt || s.created_at))
            : s.created_at;
        const customDebateMemo = debateMemos[d.debate_id]?.trim();
        sessionMap.set(virtualId, {
          ...s,
          session_id: virtualId,
          memo: customDebateMemo || d.topic.slice(0, 40),
          created_at: startedTime,
          updated_at: startedTime,
        });
        allDebates.push({
          ...d,
          session_id: virtualId,
        });
      }
    } else {
      const autoDebateTopic = sDebates[0]?.topic ?? "";
      const autoTaskTitle = sTasks[0]?.title ?? "";
      const effectiveMemo =
        (s.memo && s.memo.trim()) ||
        diskMemo.trim() ||
        autoDebateTopic.slice(0, 40) ||
        autoTaskTitle.slice(0, 40) ||
        "";
      sessionMap.set(s.session_id, {
        ...s,
        memo: effectiveMemo,
        main_model:
          s.main_model ??
          (typeof mainMeta?.model === "string" ? mainMeta.model : null),
        harness_session_id:
          s.harness_session_id ??
          (typeof mainMeta?.harnessSessionId === "string"
            ? mainMeta.harnessSessionId
            : null),
      });
      allDebates.push(...sDebates);
    }
  }

  for (const log of subagentLogs) {
    if (!log.sessionId) continue;
    if (!sessionMap.has(log.sessionId)) {
      const mainMeta = readMainJsonMeta(projectRoot, log.sessionId);
      const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
      sessionMap.set(log.sessionId, {
        session_id: log.sessionId,
        project_root: projectRoot,
        main_harness: log.harness || "claude-code",
        main_pid: null,
        phase: "done",
        state_version: 1,
        base_sha: null,
        stashed_work_sha: null,
        no_progress_count: 0,
        memo: diskMemo || log.taskId || log.role || "",
        created_at: log.startedAt || Date.now(),
        updated_at: log.finishedAt || log.startedAt || Date.now(),
      });
    }
  }

  const sessions = [...sessionMap.values()].sort((a, b) => b.created_at - a.created_at);
  const session = sessions[0] ?? null;
  const tasks = session
    ? allTasks.filter((t) => t.session_id === session.session_id)
    : [];
  const debates = session
    ? allDebates.filter((d) => d.session_id === session.session_id)
    : [];

  const cacheKey = `${projectRoot}::${homeDir ?? ""}`;
  let harnesses = doctorCache.get(cacheKey);
  if (!harnesses) {
    const hooks = getCoreInstallerHooks();
    if (hooks?.runAsdDoctor) {
      try {
        const doctor = (await hooks.runAsdDoctor({ projectRoot, homeDir })) as
          | { harnesses?: DashboardSnapshot["harnesses"] }
          | undefined;
        harnesses = doctor?.harnesses;
        if (harnesses) {
          doctorCache.set(cacheKey, harnesses);
        }
      } catch {
        // Fallback on doctor failure
      }
    }
  }

  const routingConfig = loadRoutingConfig(projectRoot, homeDir);
  const hasLocalRouting = fs.existsSync(paths.localRoutingPath);
  const availableModels = await discoverHarnessModels({
    projectRoot,
    homeDir,
    skipCliSpawn: options?.skipCliSpawn ?? false,
  });

  const worktreeStatuses: Record<string, string[]> = {};
  const nowMs = Date.now();
  for (const t of allTasks) {
    if (t.worktree_path && fs.existsSync(t.worktree_path)) {
      const wtKey = path.resolve(t.worktree_path);
      const cachedWt = worktreeStatusCache.get(wtKey);
      if (cachedWt && cachedWt.expiresAt > nowMs) {
        if (cachedWt.lines.length > 0) {
          worktreeStatuses[`${t.session_id}::${t.task_id}`] = cachedWt.lines;
        }
        continue;
      }
      try {
        const res = child_process.spawnSync("git", ["status", "--short"], {
          cwd: t.worktree_path,
          encoding: "utf8",
          timeout: 1500,
          windowsHide: true,
        });
        if (res.status === 0 && typeof res.stdout === "string") {
          const lines = res.stdout
            .split(/\r?\n/)
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0 && !l.includes("node_modules"));
          worktreeStatusCache.set(wtKey, {
            lines,
            expiresAt: nowMs + WORKTREE_STATUS_CACHE_TTL_MS,
          });
          if (lines.length > 0) {
            worktreeStatuses[`${t.session_id}::${t.task_id}`] = lines;
          }
        }
      } catch {
        // ignore worktree status errors
      }
    }
  }

  return {
    version: ASD_VERSION,
    projectRoot,
    systemLocale: detectSystemLocale(),
    timestamp: Date.now(),
    session,
    sessions,
    tasks,
    allTasks,
    debates,
    allDebates,
    drivers,
    subagentLogs,
    cliRecentSessions: (() => {
      const throttleMs = options?.transcriptSyncThrottleMs ?? TRANSCRIPT_SYNC_THROTTLE_MS;
      const lastSyncAt = transcriptSyncThrottleCache.get(cacheKey) ?? 0;
      const shouldSync =
        options?.syncLocalTranscripts !== undefined
          ? options.syncLocalTranscripts
          : nowMs - lastSyncAt >= throttleMs;
      if (shouldSync) {
        transcriptSyncThrottleCache.set(cacheKey, nowMs);
      }
      return readCliRecentSessions(projectRoot, {
        syncLocalTranscripts: shouldSync,
        homeDir,
      });
    })(),
    routingConfig,
    hasLocalRouting,
    localRoutingPath: paths.localRoutingPath,
    availableModels,
    worktreeStatuses,
    harnesses,
  };
}
