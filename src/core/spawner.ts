/**
 * ASD v2.2 Subagent Spawner (src/core/spawner.ts)
 *
 * Spawns isolated subagent processes with:
 * - Session artifact logging under
 *   <projectRoot>/.asd/sessions/<mainSessionId>/subagents/<subSessionId>/:
 *   meta.json (SubagentSessionMeta), prompt.md, output.log.
 * - Secret-redacted log piping: every stdout/stderr chunk passes through
 *   redactSecrets BEFORE it is written to output.log.
 * - Env injection for MCP recursion blocking (fork-bomb prevention):
 *   NODE_NO_WARNINGS=1, ASD_MAIN_SESSION_ID, ASD_SESSION_ROLE=subagent,
 *   ASD_SUBAGENT_META=<abs path to meta.json>.
 * - AbortSignal + timeout integration with process-tree termination
 *   (Windows: taskkill /PID <pid> /T /F; POSIX: kill -TERM -pgid then
 *   SIGKILL after 3s) so cancellation leaves zero zombie processes.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAsdPaths } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import {
  extractHarnessSessionIdFromOutput,
  isValidAsdSessionId,
} from "./session-tracker.ts";
import { appendCursorStreamFallback } from "./transcripts.ts";
import type { AgentRole, HarnessId, SubagentDispatchMode, SubagentSessionMeta } from "./types.ts";

// ============================================================================
// Spawn command builder with per-harness stdin offloading
// ============================================================================

/**
 * Conservative total command-line argv budget (chars).
 * Windows CreateProcess limit is ~32,767 chars; we leave headroom for
 * the executable path, env block, and Node's internal overhead.
 */
export const MAX_ARGV_CHARS = 30_000;

/**
 * Per-harness stdin capability specification.
 * - stdinSupported: whether the harness can read the prompt from stdin.
 * - stdinMarker: the argument value that tells the harness "read prompt from stdin"
 *   (e.g., "-" for codex). If null, the prompt argument is simply omitted.
 * - promptArgFlag: the flag that precedes the prompt argument (e.g., "-p").
 *   Used to locate and remove the prompt from argv when offloading to stdin.
 */
export interface HarnessStdinSpec {
  stdinSupported: boolean;
  stdinMarker: string | null;
  promptArgFlag: string | null;
}

/**
 * Returns the stdin capability spec for a given harness.
 * Only claude-code and codex support prompt stdin offloading.
 * antigravity, cursor, and opencode do NOT support reading a simple prompt from stdin.
 */
export function getHarnessStdinSpec(harness: HarnessId): HarnessStdinSpec {
  switch (harness) {
    case "claude-code":
      return { stdinSupported: true, stdinMarker: null, promptArgFlag: "-p" };
    case "codex":
      return { stdinSupported: true, stdinMarker: "-", promptArgFlag: "exec" };
    case "antigravity":
    case "cursor":
    case "opencode":
      return { stdinSupported: false, stdinMarker: null, promptArgFlag: null };
  }
}

/**
 * Builds the final spawn command/args, offloading the prompt to stdin when:
 * - the harness supports stdin, AND
 * - the total argv length would exceed MAX_ARGV_CHARS.
 *
 * For claude-code, preserves existing behavior: also offloads when prompt > 1500 chars
 * (the original threshold) even if total argv is under budget.
 *
 * Returns { command, args, stdinPayload?, closeStdinOnSpawn? }.
 * If stdin offloading is needed but the harness doesn't support it, throws an Error
 * with a clear message instead of letting spawn throw ENAMETOOLONG.
 */
export function buildSpawnCommand(
  harness: HarnessId,
  command: string,
  args: string[],
  prompt: string
): { command: string; args: string[]; stdinPayload?: string; closeStdinOnSpawn?: boolean } {
  const spec = getHarnessStdinSpec(harness);
  const totalArgChars = args.reduce((acc, a) => acc + a.length, 0) + command.length;
  const promptLen = prompt.length;

  const claudeLegacyTrigger = harness === "claude-code" && promptLen > 1500;
  const argvBudgetExceeded = totalArgChars > MAX_ARGV_CHARS;

  if (!claudeLegacyTrigger && !argvBudgetExceeded) {
    return { command, args };
  }

  if (!spec.stdinSupported) {
    throw new Error(
      `Harness '${harness}' does not support stdin prompt offloading; ` +
        `argv length (${totalArgChars} chars) exceeds safe budget (${MAX_ARGV_CHARS} chars). ` +
        `Reduce prompt size or use a harness that supports stdin (claude-code, codex).`
    );
  }

  let newArgs = [...args];
  let stdinPayload = prompt;
  let closeStdinOnSpawn = true;

  if (harness === "claude-code") {
    const pIdx = newArgs.indexOf("-p");
    if (pIdx !== -1 && pIdx + 1 < newArgs.length) {
      newArgs.splice(pIdx + 1, 1);
    }
  } else if (harness === "codex") {
    const execIdx = newArgs.indexOf("exec");
    if (execIdx !== -1 && execIdx + 1 < newArgs.length) {
      newArgs[execIdx + 1] = "-";
    }
  }

  return { command, args: newArgs, stdinPayload, closeStdinOnSpawn };
}

// ============================================================================
// CommandRunner contract (mockable for deterministic tests)
// ============================================================================

export interface CommandRunnerRunOptions {
  cwd?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  stdinPayload?: string;
  closeStdinOnSpawn?: boolean;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** Called synchronously with the child pid as soon as the process exists. */
  onSpawn?: (pid: number) => void;
}

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: CommandRunnerRunOptions
  ): Promise<{ exitCode: number; pid: number }>;
}

// ============================================================================
// Spawn options / result
// ============================================================================

export interface SpawnSubagentOptions {
  projectRoot: string;
  homeDir?: string;
  mainSessionId: string;
  subSessionId: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  harnessSessionId?: string | null;
  taskId: string;
  prompt: string;
  allowedFiles: string[];
  worktreePath?: string | null;
  command: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  cwd?: string;
  commandRunner?: CommandRunner;
  dispatchMode?: SubagentDispatchMode;
  ownerPid?: number;
  stdinPayload?: string;
  closeStdinOnSpawn?: boolean;
}

export const DEFAULT_DISPATCH_TIMEOUT_MS =
  Number.parseInt(process.env.ASD_SPAWN_TIMEOUT_MS || "", 10) || 60 * 60_000;
export const DEFAULT_DEBATE_TIMEOUT_MS =
  Number.parseInt(
    process.env.ASD_DEBATE_TIMEOUT_MS || process.env.ASD_SPAWN_TIMEOUT_MS || "",
    10
  ) || 15 * 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS =
  Number.parseInt(process.env.ASD_SPAWN_IDLE_TIMEOUT_MS || "", 10) ||
  10 * 60_000;

export interface SpawnSubagentResult {
  exitCode: number;
  durationMs: number;
  metaPath: string;
  harnessSessionId?: string | null;
  timedOut?: boolean;
}

// ============================================================================
// Windows .cmd / npm Shim Safe Resolver
// ============================================================================

/**
 * Resolves a command and arguments for safe cross-platform execution.
 * On Windows, npm global CLIs (`claude`, `codex`, `opencode`, `agy`, `npx`)
 * are installed as `.cmd` batch shims, which throw ENOENT when spawned with
 * `shell: false`, or break on multiline prompts when spawned with `shell: true`.
 *
 * This resolver locates the `.cmd` shim on PATH, extracts the underlying Node.js
 * entrypoint script if it is an npm shim, and invokes `process.execPath` directly
 * with `shell: false`.
 */
export function resolveSpawnCommand(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = process.env
): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") {
    return { command: cmd, args, shell: false };
  }

  // Direct node or .exe invocation needs no translation
  const lowerCmd = cmd.toLowerCase();
  if (lowerCmd === "node" || lowerCmd === "node.exe" || lowerCmd.endsWith(".exe")) {
    return { command: cmd, args, shell: false };
  }

  // Locate candidate on PATH if not already an existing path
  let resolvedPath = "";
  if (path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/")) {
    if (fs.existsSync(cmd)) {
      resolvedPath = cmd;
    } else if (fs.existsSync(`${cmd}.cmd`)) {
      resolvedPath = `${cmd}.cmd`;
    } else if (fs.existsSync(`${cmd}.exe`)) {
      return { command: `${cmd}.exe`, args, shell: false };
    }
  } else {
    const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || "";
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const exeCandidate = path.join(dir, `${cmd}.exe`);
      if (fs.existsSync(exeCandidate)) {
        return { command: exeCandidate, args, shell: false };
      }
      const cmdCandidate = path.join(dir, `${cmd}.cmd`);
      if (fs.existsSync(cmdCandidate)) {
        resolvedPath = cmdCandidate;
        break;
      }
      const batCandidate = path.join(dir, `${cmd}.bat`);
      if (fs.existsSync(batCandidate)) {
        resolvedPath = batCandidate;
        break;
      }
    }
  }

  if (resolvedPath && /\.(cmd|bat)$/i.test(resolvedPath)) {
    try {
      const shimContent = fs.readFileSync(resolvedPath, "utf8");
      const shimDir = path.dirname(resolvedPath);
      // Match standard npm cmd shim pattern: "%dp0%\node_modules\...\bin.js" %*
      const match = shimContent.match(/"%(?:~)?dp0%\\([^"]+\.(?:c?m?js))"\s+%\*/i);
      if (match?.[1]) {
        const scriptPath = path.resolve(shimDir, match[1]);
        if (fs.existsSync(scriptPath)) {
          return {
            command: process.execPath,
            args: [scriptPath, ...args],
            shell: false,
          };
        }
      }
    } catch {
      // Fall through to cmd.exe wrapper
    }
    const finalCmd =
      resolvedPath.includes(" ") && !(resolvedPath.startsWith('"') && resolvedPath.endsWith('"'))
        ? `"${resolvedPath}"`
        : resolvedPath;
    const finalArgs = args.map((arg) => {
      if (/\s/.test(arg) && !(arg.startsWith('"') && arg.endsWith('"'))) {
        return `"${arg}"`;
      }
      return arg;
    });
    return { command: finalCmd, args: finalArgs, shell: true };
  }

  return { command: cmd, args, shell: false };
}

/**
 * Probes whether a CLI binary exists and supports headless `-p` / `--print`
 * execution via its `--help` output. Never throws — returns false on binary
 * absence, spawn failure, timeout, or missing print mode.
 */
export function probeHeadlessBinary(
  binaryName: string,
  opts?: { shell?: boolean; timeoutMs?: number }
): boolean {
  try {
    const res = child_process.spawnSync(binaryName, ["--help"], {
      stdio: "pipe",
      timeout: opts?.timeoutMs ?? 2000,
      windowsHide: true,
      encoding: "utf8",
      shell: opts?.shell ?? false,
    });
    if (res.error || res.status !== 0) {
      return false;
    }
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    return out.includes("--print") || out.includes("-p");
  } catch {
    return false;
  }
}

// ============================================================================
// Default runner: real child_process.spawn
// ============================================================================

const defaultCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: { exitCode: number; pid: number }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const resolved = resolveSpawnCommand(cmd, args, opts.env);
      let finalArgs = resolved.args;
      let stdinPayload: string | undefined = opts.stdinPayload;
      let closeStdinOnSpawn = opts.closeStdinOnSpawn ?? false;
      const shouldPipeStdin = stdinPayload !== undefined || closeStdinOnSpawn;
      let child: child_process.ChildProcess;
      try {
        child = child_process.spawn(resolved.command, finalArgs, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: [shouldPipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: resolved.shell,
          detached: process.platform !== "win32",
        });
      } catch (err) {
        const totalArgChars = finalArgs.reduce((acc, a) => acc + a.length, 0);
        const argHint =
          totalArgChars > 8000
            ? ` (arg length: ${totalArgChars} chars — may exceed OS command-line limit)`
            : "";
        opts.onStderr(
          `[SPAWN_ERROR] [asd:spawn-error] Failed to spawn '${resolved.command}': ${(err as Error).message}${argHint}\n`
        );
        safeResolve({ exitCode: -1, pid: -1 });
        return;
      }
      if (child.stdin) {
        try {
          if (stdinPayload !== undefined) {
            child.stdin.write(stdinPayload, "utf8");
          }
          if (stdinPayload !== undefined || closeStdinOnSpawn) {
            child.stdin.end();
          }
        } catch {
          // ignore broken pipe
        }
      }
      opts.onSpawn?.(child.pid ?? 0);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => opts.onStdout(chunk));
      child.stderr?.on("data", (chunk: string) => opts.onStderr(chunk));
      child.on("close", (code) =>
        safeResolve({ exitCode: code ?? -1, pid: child.pid ?? -1 })
      );
      child.on("error", (err) => {
        const totalArgChars = finalArgs.reduce((acc, a) => acc + a.length, 0);
        const argHint =
          totalArgChars > 8000
            ? ` (arg length: ${totalArgChars} chars — may exceed OS command-line limit)`
            : "";
        opts.onStderr(
          `[SPAWN_ERROR] [asd:spawn-error] Failed to spawn '${resolved.command}': ${err.message}${argHint}\n`
        );
        safeResolve({ exitCode: -1, pid: child.pid ?? -1 });
      });
    });
  },
};

// ============================================================================
// Process-tree termination
// ============================================================================

/**
 * Kill an entire process tree. Best-effort: already-exited targets are
 * silently ignored (ESRCH-like failures swallowed).
 * - Windows: `taskkill /PID <pid> /T /F` (reliable tree kill).
 * - POSIX: SIGTERM to the process group, then SIGKILL after 3s.
 */
export function killProcessTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      child_process.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Already exited (or taskkill unavailable) — nothing to do.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // Process group already gone.
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone — fine.
    }
  }, 3000);
  killTimer.unref?.();
}

export interface AbortSessionOptions {
  harness: HarnessId;
  pid?: number;
  mode?: string;
  isSharedDaemon?: boolean;
  abortController?: AbortController;
  serverUrl?: string;
  sessionId?: string;
}

export function abortSession(options: AbortSessionOptions): void {
  if (options.harness === "opencode" && (options.mode === "daemon-sse" || options.isSharedDaemon === true)) {
    options.abortController?.abort();
    if (options.serverUrl && options.sessionId) {
      try {
        void fetch(`${options.serverUrl.replace(/\/+$/, "")}/session/${options.sessionId}/abort`, {
          method: "POST",
        }).catch(() => {});
      } catch {
        // best-effort
      }
    }
    return;
  }
  if (options.pid && options.pid > 0) {
    killProcessTree(options.pid);
  }
}

export interface ShutdownDaemonOptions {
  harness: HarnessId;
  pid: number;
  ownedByAsd?: boolean;
  activeSubagents?: number;
}

export function shutdownDaemon(options: ShutdownDaemonOptions): boolean {
  if (options.harness === "opencode") {
    if (options.ownedByAsd === true && (options.activeSubagents ?? 0) <= 0) {
      if (options.pid > 0) {
        killProcessTree(options.pid);
        return true;
      }
    }
    return false;
  }
  if (options.pid > 0) {
    killProcessTree(options.pid);
    return true;
  }
  return false;
}

// ============================================================================
// spawnSubagent
// ============================================================================

/**
 * Spawn an isolated subagent process, record its session artifacts, and
 * resolve with { exitCode, durationMs, metaPath } once the child exits,
 * is aborted via options.signal, or exceeds options.timeoutMs.
 * Aborted/timed-out children are tree-killed and marked "failed" in meta.json.
 */
export interface ExecuteHarnessProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  harness: HarnessId;
  initialHarnessSessionId?: string | null;
  logPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  commandRunner?: CommandRunner;
  stdinPayload?: string;
  closeStdinOnSpawn?: boolean;
  onSpawn?: (pid: number) => void;
  onSessionIdDetected?: (harnessSessionId: string) => void;
  onOutput?: (redactedChunk: string) => void;
  onBeforeStreamEnd?: (res: {
    exitCode: number;
    pid: number;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    harnessSessionId: string | null;
    timedOut: boolean;
    status: "done" | "failed";
    errorSummary?: string;
  }) => void;
}

export interface ExecuteHarnessProcessResult {
  exitCode: number;
  pid: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  harnessSessionId: string | null;
  timedOut: boolean;
  status: "done" | "failed";
  errorSummary?: string;
}

/**
 * Shared headless process execution helper used by both spawnSubagent and runDriverTurn.
 */
export function executeHarnessProcess(
  options: ExecuteHarnessProcessOptions
): Promise<ExecuteHarnessProcessResult> {
  const startedAt = Date.now();
  let detectedHarnessSessionId: string | null =
    options.initialHarnessSessionId ?? null;

  const logStream = fs.createWriteStream(options.logPath, { flags: "a" });
  logStream.on("error", () => {});

  const runner = options.commandRunner ?? defaultCommandRunner;
  const effectiveTimeoutMs =
    options.timeoutMs !== undefined && options.maxDurationMs !== undefined
      ? Math.min(options.timeoutMs, options.maxDurationMs)
      : (options.timeoutMs ?? options.maxDurationMs);

  return new Promise<ExecuteHarnessProcessResult>((resolve) => {
    let pid = 0;
    let settled = false;
    let killRequested = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionDetectBuffer = "";

    const finish = (
      exitCode: number,
      status: "done" | "failed",
      errorSummary?: string
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      if (!detectedHarnessSessionId && sessionDetectBuffer.length > 0) {
        const extracted = extractHarnessSessionIdFromOutput(
          sessionDetectBuffer.replace(/\r$/, ""),
          options.harness
        );
        if (extracted) {
          detectedHarnessSessionId = extracted;
          options.onSessionIdDetected?.(extracted);
        }
        sessionDetectBuffer = "";
      }
      if (errorSummary) {
        const redacted = redactSecrets(errorSummary);
        logStream.write(redacted);
        options.onOutput?.(redacted);
      }
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;
      const result: ExecuteHarnessProcessResult = {
        exitCode,
        pid,
        startedAt,
        finishedAt,
        durationMs,
        harnessSessionId: detectedHarnessSessionId,
        timedOut,
        status,
        errorSummary,
      };
      options.onBeforeStreamEnd?.(result);
      logStream.end(() => {
        resolve(result);
      });
    };

    const requestKill = (): void => {
      killRequested = true;
      if (pid > 0) killProcessTree(pid);
    };

    const onAbort = (): void => {
      requestKill();
      finish(-1, "failed");
    };

    const onHardTimeout = (): void => {
      timedOut = true;
      handleChunk(
        `[TIMEOUT] Process exceeded timeout (${effectiveTimeoutMs}ms)\n`
      );
      onAbort();
    };

    const onIdleTimeout = (): void => {
      timedOut = true;
      handleChunk(
        `[IDLE_TIMEOUT] Process produced no output for ${options.idleTimeoutMs}ms\n`
      );
      onAbort();
    };

    const resetIdleTimer = (): void => {
      if (options.idleTimeoutMs === undefined || settled) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdleTimeout, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted && !settled) onAbort();
    }
    if (effectiveTimeoutMs !== undefined) {
      timer = setTimeout(onHardTimeout, effectiveTimeoutMs);
      timer.unref?.();
    }
    resetIdleTimer();

    const handleChunk = (chunk: string): void => {
      if (settled) return;
      if (chunk && chunk.length > 0) {
        resetIdleTimer();
        const fallbackHome = options.env?.HOME || options.env?.USERPROFILE;
        if (options.harness === "cursor" && detectedHarnessSessionId) {
          appendCursorStreamFallback(detectedHarnessSessionId, chunk, { homeDir: fallbackHome });
        }
        if (!detectedHarnessSessionId) {
          sessionDetectBuffer += chunk;
          let nlIdx = sessionDetectBuffer.indexOf("\n");
          while (nlIdx !== -1) {
            const line = sessionDetectBuffer.slice(0, nlIdx).replace(/\r$/, "");
            sessionDetectBuffer = sessionDetectBuffer.slice(nlIdx + 1);
            if (!detectedHarnessSessionId) {
              const extracted = extractHarnessSessionIdFromOutput(
                line,
                options.harness
              );
              if (extracted) {
                detectedHarnessSessionId = extracted;
                options.onSessionIdDetected?.(extracted);
                if (options.harness === "cursor") {
                  appendCursorStreamFallback(detectedHarnessSessionId, sessionDetectBuffer, { homeDir: fallbackHome });
                }
              }
            }
            nlIdx = sessionDetectBuffer.indexOf("\n");
          }
        }
      }
      const redacted = redactSecrets(chunk);
      logStream.write(redacted);
      if (redacted.length > 0) {
        options.onOutput?.(redacted);
      }
    };

    void runner
      .run(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdinPayload: options.stdinPayload,
        closeStdinOnSpawn: options.closeStdinOnSpawn,
        onStdout: handleChunk,
        onStderr: handleChunk,
        onSpawn: (p) => {
          pid = p;
          options.onSpawn?.(pid);
          if (killRequested) killProcessTree(pid);
        },
      })
      .then(
        (result) => {
          if (pid === 0 && result.pid > 0) {
            pid = result.pid;
          }
          finish(result.exitCode, result.exitCode === 0 ? "done" : "failed");
        },
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          finish(-1, "failed", `[SPAWN_ERROR] Runner rejected: ${msg}\n`);
        }
      );
  });
}

export function spawnSubagent(
  options: SpawnSubagentOptions
): Promise<SpawnSubagentResult> {
  if (!isValidAsdSessionId(options.mainSessionId)) {
    return Promise.reject(new Error("INVALID_SESSION_ID"));
  }
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

  fs.writeFileSync(path.join(sessionDir, "prompt.md"), options.prompt);

  const startedAt = Date.now();
  let meta: SubagentSessionMeta = {
    subSessionId: options.subSessionId,
    parentSessionId: options.mainSessionId,
    roleType: "subagent",
    role: options.role,
    harness: options.harness,
    model: options.model,
    harnessSessionId: options.harnessSessionId ?? null,
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

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  env.NODE_NO_WARNINGS = "1";
  env.ASD_MAIN_SESSION_ID = options.mainSessionId;
  env.ASD_SESSION_ROLE = "subagent";
  env.ASD_SUBAGENT_META = metaPath;

  return executeHarnessProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env,
    harness: options.harness,
    initialHarnessSessionId: options.harnessSessionId ?? null,
    logPath,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxDurationMs: options.maxDurationMs,
    idleTimeoutMs: options.idleTimeoutMs,
    commandRunner: options.commandRunner,
    stdinPayload: options.stdinPayload,
    closeStdinOnSpawn: options.closeStdinOnSpawn ?? true,
    onSpawn: (pid) => {
      meta = { ...meta, pid };
      writeMeta();
    },
    onSessionIdDetected: (extracted) => {
      meta = { ...meta, harnessSessionId: extracted };
      writeMeta();
    },
    onBeforeStreamEnd: (res) => {
      meta = {
        ...meta,
        pid: res.pid,
        exitCode: res.exitCode,
        harnessSessionId: res.harnessSessionId,
        status: res.status,
        startedAt: res.startedAt,
        finishedAt: res.finishedAt,
        durationMs: res.durationMs,
        errorSummary: res.errorSummary,
      };
      writeMeta();
    },
  }).then((res) => ({
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    metaPath,
    harnessSessionId: res.harnessSessionId,
    timedOut: res.timedOut,
  }));
}

// ============================================================================
// CR-09: Subagent Artifact Lifecycle (finalizeSubagentArtifacts)
// ============================================================================

/**
 * Purges prompt.md and output.log (or keeps last 8KB of output.log when keep === 'tail')
 * once a subagent reaches a terminal state (done / failed), while preserving meta.json.
 */
export function finalizeSubagentArtifacts(input: {
  projectRoot: string;
  sessionId: string;
  subSessionId: string;
  keep?: "none" | "tail";
}): void {
  if (!input.sessionId || !input.subSessionId) return;
  const paths = resolveAsdPaths(input.projectRoot);
  const subDir = path.join(
    paths.sessionsDir,
    input.sessionId,
    "subagents",
    input.subSessionId
  );
  if (!fs.existsSync(subDir)) return;

  const promptPath = path.join(subDir, "prompt.md");
  const logPath = path.join(subDir, "output.log");

  try {
    if (fs.existsSync(promptPath)) {
      fs.unlinkSync(promptPath);
    }
  } catch {
    // Best-effort cleanup
  }

  try {
    if (fs.existsSync(logPath)) {
      if (input.keep === "tail") {
        const buf = fs.readFileSync(logPath);
        const tailBytes = 8 * 1024;
        if (buf.length > tailBytes) {
          fs.writeFileSync(logPath, buf.subarray(buf.length - tailBytes));
        }
      } else {
        fs.unlinkSync(logPath);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
