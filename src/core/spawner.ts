/**
 * ASD v2.7.0 Subagent Spawner (src/core/spawner.ts)
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
import * as os from "node:os";
import * as path from "node:path";
import { resolveAsdPaths } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import {
  extractHarnessSessionIdFromOutput,
  isValidAsdSessionId,
} from "./session-tracker.ts";
import { appendCursorStreamFallback } from "./transcripts.ts";
import type {
  AgentRole,
  HarnessId,
  SubagentDispatchMode,
  SubagentSessionMeta,
  TaskTelemetry,
} from "./types.ts";

// ============================================================================
// Best-effort Token & Cost Telemetry Extraction (CLI JSON stream & ACP)
// ============================================================================

function toNonNegativeNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickFirstNumber(
  obj: Record<string, unknown> | null,
  keys: readonly string[]
): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const n = toNonNegativeNumber(obj[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function extractUsageFromContainer(
  container: Record<string, unknown>
): TaskTelemetry | null {
  const inputTokens = pickFirstNumber(container, [
    "input_tokens",
    "inputTokens",
    "input",
    "prompt_tokens",
    "promptTokens",
    "promptTokenCount",
  ]);
  const outputTokens = pickFirstNumber(container, [
    "output_tokens",
    "outputTokens",
    "output",
    "completion_tokens",
    "completionTokens",
    "candidatesTokenCount",
  ]);

  let cacheTokens = pickFirstNumber(container, [
    "cache_tokens",
    "cacheTokens",
    "cached_input_tokens",
    "cachedInputTokens",
    "cached_tokens",
    "cachedTokens",
    "cachedContentTokenCount",
  ]);
  if (cacheTokens === undefined) {
    const cacheRead =
      pickFirstNumber(container, [
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cache_read_tokens",
        "cacheReadTokens",
      ]) ?? pickFirstNumber(asRecord(container.cache), ["read"]);
    const cacheWrite =
      pickFirstNumber(container, [
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
        "cache_write_tokens",
        "cacheWriteTokens",
      ]) ?? pickFirstNumber(asRecord(container.cache), ["write"]);
    if (cacheRead !== undefined || cacheWrite !== undefined) {
      cacheTokens = (cacheRead ?? 0) + (cacheWrite ?? 0);
    } else {
      const inputDetails = asRecord(container.input_tokens_details) ?? asRecord(container.prompt_tokens_details);
      cacheTokens = pickFirstNumber(inputDetails, ["cached_tokens", "cachedTokens"]);
    }
  }

  let reasoningTokens = pickFirstNumber(container, [
    "reasoning_tokens",
    "reasoningTokens",
    "reasoning",
    "thoughtsTokenCount",
    "thinking_tokens",
    "thinkingTokens",
  ]);
  if (reasoningTokens === undefined) {
    const outDetails =
      asRecord(container.output_tokens_details) ??
      asRecord(container.completion_tokens_details);
    reasoningTokens = pickFirstNumber(outDetails, [
      "reasoning_tokens",
      "reasoningTokens",
      "thinking_tokens",
      "thinkingTokens",
    ]);
  }

  const costUsd = pickFirstNumber(container, [
    "costUsd",
    "cost_usd",
    "total_cost_usd",
    "totalCostUsd",
    "costUSD",
    "cost",
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheTokens === undefined &&
    reasoningTokens === undefined &&
    costUsd === undefined
  ) {
    return null;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheTokens !== undefined ? { cacheTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Best-effort extraction of TaskTelemetry from a single parsed JSON event
 * (Claude Code, Codex, OpenCode, Cursor, Antigravity, or ACP metadata).
 * Never throws; returns null when no telemetry fields are present.
 */
export function extractTelemetryFromJsonEvent(
  event: unknown,
  _harness?: HarnessId
): TaskTelemetry | null {
  try {
    const root = asRecord(event);
    if (!root) return null;

    const merged: TaskTelemetry = {};
    const apply = (t: TaskTelemetry | null): void => {
      if (!t) return;
      if (t.inputTokens !== undefined) merged.inputTokens = t.inputTokens;
      if (t.outputTokens !== undefined) merged.outputTokens = t.outputTokens;
      if (t.cacheTokens !== undefined) merged.cacheTokens = t.cacheTokens;
      if (t.reasoningTokens !== undefined) merged.reasoningTokens = t.reasoningTokens;
      if (t.costUsd !== undefined) merged.costUsd = t.costUsd;
    };

    const msg = asRecord(root.message);
    const part = asRecord(root.part);
    const resultObj = asRecord(root.result);
    const responseObj = asRecord(root.response);
    const metaObj = asRecord(root._meta) ?? asRecord(root.metadata);
    const statsObj = asRecord(root.stats);

    const candidates: Array<Record<string, unknown> | null> = [
      root,
      asRecord(root.usage),
      asRecord(root.usageMetadata),
      asRecord(root.tokens),
      asRecord(msg?.usage),
      part,
      asRecord(part?.tokens),
      asRecord(part?.usage),
      resultObj,
      asRecord(resultObj?.usage),
      responseObj,
      asRecord(responseObj?.usage),
      metaObj,
      asRecord(metaObj?.usage),
      asRecord(metaObj?.tokens),
      statsObj,
    ];

    for (const c of candidates) {
      if (c) apply(extractUsageFromContainer(c));
    }

    // Claude Code modelUsage map: sum across models when top-level usage is absent
    const modelUsage = asRecord(root.modelUsage);
    if (modelUsage) {
      let mIn = 0;
      let mOut = 0;
      let mCache = 0;
      let mReason = 0;
      let mCost = 0;
      let hasIn = false;
      let hasOut = false;
      let hasCache = false;
      let hasReason = false;
      let hasCost = false;
      for (const val of Object.values(modelUsage)) {
        const rec = asRecord(val);
        if (!rec) continue;
        const t = extractUsageFromContainer(rec);
        if (!t) continue;
        if (t.inputTokens !== undefined) { mIn += t.inputTokens; hasIn = true; }
        if (t.outputTokens !== undefined) { mOut += t.outputTokens; hasOut = true; }
        if (t.cacheTokens !== undefined) { mCache += t.cacheTokens; hasCache = true; }
        if (t.reasoningTokens !== undefined) { mReason += t.reasoningTokens; hasReason = true; }
        if (t.costUsd !== undefined) { mCost += t.costUsd; hasCost = true; }
      }
      if (merged.inputTokens === undefined && hasIn) merged.inputTokens = mIn;
      if (merged.outputTokens === undefined && hasOut) merged.outputTokens = mOut;
      if (merged.cacheTokens === undefined && hasCache) merged.cacheTokens = mCache;
      if (merged.reasoningTokens === undefined && hasReason) merged.reasoningTokens = mReason;
      if (merged.costUsd === undefined && hasCost) merged.costUsd = mCost;
    }

    if (
      merged.inputTokens === undefined &&
      merged.outputTokens === undefined &&
      merged.cacheTokens === undefined &&
      merged.reasoningTokens === undefined &&
      merged.costUsd === undefined
    ) {
      return null;
    }
    return merged;
  } catch {
    return null;
  }
}

export function mergeTaskTelemetry(
  current: TaskTelemetry | undefined,
  incoming: TaskTelemetry | null | undefined,
  mode: "replace" | "accumulate" = "replace"
): TaskTelemetry | undefined {
  if (!incoming) return current;
  if (!current) return { ...incoming };

  const out: TaskTelemetry = { ...current };
  const keys: Array<keyof TaskTelemetry> = [
    "inputTokens",
    "outputTokens",
    "cacheTokens",
    "reasoningTokens",
    "costUsd",
  ];
  for (const k of keys) {
    const val = incoming[k];
    if (val === undefined) continue;
    if (mode === "accumulate") {
      out[k] = (out[k] ?? 0) + val;
    } else {
      out[k] = val;
    }
  }
  return out;
}

function isAccumulativeStepEvent(event: unknown): boolean {
  const root = asRecord(event);
  if (!root) return false;
  if (root.type === "step_finish" || root.type === "step-finish") return true;
  const part = asRecord(root.part);
  if (part && (part.type === "step_finish" || part.type === "step-finish")) return true;
  return false;
}

/**
 * Parses a newline-delimited CLI output string and extracts best-effort TaskTelemetry.
 * Never throws; returns undefined when no telemetry is found.
 */
export function extractTelemetryFromOutput(
  output: string,
  harness?: HarnessId
): TaskTelemetry | undefined {
  let telemetry: TaskTelemetry | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const extracted = extractTelemetryFromJsonEvent(parsed, harness);
      if (extracted) {
        telemetry = mergeTaskTelemetry(
          telemetry,
          extracted,
          isAccumulativeStepEvent(parsed) ? "accumulate" : "replace"
        );
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
  return telemetry;
}

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
 * - the total argv length would exceed MAX_ARGV_CHARS (or prompt > 1500 chars for claude-code).
 *
 * When argv exceeds MAX_ARGV_CHARS on a harness without stdin prompt support
 * (opencode, antigravity, cursor), writes the prompt to a restricted temporary
 * markdown file and replaces the oversized argv prompt with a short file-pointer
 * instruction so spawn never crashes with ENAMETOOLONG.
 */
export function buildSpawnCommand(
  harness: HarnessId,
  command: string,
  args: string[],
  prompt: string
): {
  command: string;
  args: string[];
  stdinPayload?: string;
  closeStdinOnSpawn?: boolean;
  promptFilePath?: string;
} {
  const spec = getHarnessStdinSpec(harness);
  const totalArgChars = args.reduce((acc, a) => acc + a.length, 0) + command.length;
  const promptLen = prompt.length;

  const claudeLegacyTrigger = harness === "claude-code" && promptLen > 1500;
  const argvBudgetExceeded = totalArgChars > MAX_ARGV_CHARS;

  if (!claudeLegacyTrigger && !argvBudgetExceeded) {
    return { command, args };
  }

  let newArgs = [...args];

  if (!spec.stdinSupported) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-prompt-"));
    try {
      fs.chmodSync(tmpDir, 0o700);
    } catch {
      // Windows chmod best-effort
    }
    const promptFilePath = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(promptFilePath, prompt, { encoding: "utf8", mode: 0o600 });
    const pointerPrompt =
      `Read the complete task instructions from file "${promptFilePath}" and execute all requirements within.`;

    let replaced = false;
    if (harness === "antigravity" || harness === "cursor") {
      const pIdx = newArgs.indexOf("-p");
      if (pIdx !== -1 && pIdx + 1 < newArgs.length) {
        newArgs[pIdx + 1] = pointerPrompt;
        replaced = true;
      }
    } else if (harness === "opencode") {
      const runIdx = newArgs.indexOf("run");
      if (runIdx !== -1 && runIdx + 1 < newArgs.length) {
        newArgs[runIdx + 1] = pointerPrompt;
        replaced = true;
      }
    }
    if (!replaced) {
      const exactIdx = newArgs.indexOf(prompt);
      if (exactIdx !== -1) {
        newArgs[exactIdx] = pointerPrompt;
      }
    }

    return { command, args: newArgs, promptFilePath };
  }

  const stdinPayload = prompt;
  const closeStdinOnSpawn = true;

  if (harness === "claude-code") {
    const pIdx = newArgs.indexOf("-p");
    if (pIdx !== -1 && pIdx + 1 < newArgs.length) {
      newArgs.splice(pIdx + 1, 1);
    }
  } else if (harness === "codex") {
    const execIdx = newArgs.indexOf("exec");
    if (execIdx !== -1) {
      if (newArgs[execIdx + 1] === "resume" && execIdx + 3 < newArgs.length) {
        newArgs[execIdx + 3] = "-";
      } else if (execIdx + 1 < newArgs.length) {
        newArgs[execIdx + 1] = "-";
      }
    }
  }

  return { command, args: newArgs, stdinPayload, closeStdinOnSpawn };
}

// ============================================================================
// CommandRunner contract (mockable for deterministic tests)
// ============================================================================

export interface CommandRunnerRunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
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
  allowSlidingTimeout?: boolean;
  cwd?: string;
  commandRunner?: CommandRunner;
  dispatchMode?: SubagentDispatchMode;
  ownerPid?: number;
  stdinPayload?: string;
  closeStdinOnSpawn?: boolean;
  promptFilePath?: string;
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
export const DEFAULT_MAX_WALL_TIMEOUT_MS =
  Number.parseInt(process.env.ASD_MAX_WALL_TIMEOUT_MS || "", 10) ||
  4 * 60 * 60_000;

export interface SpawnSubagentResult {
  exitCode: number;
  durationMs: number;
  metaPath: string;
  harnessSessionId?: string | null;
  timedOut?: boolean;
  timeoutReason?: "idle" | "wall_clock";
  telemetry?: TaskTelemetry;
}

// ============================================================================
// Windows .cmd / .ps1 / npm Shim Safe Resolver
// ============================================================================

function findPowerShellExecutable(
  env: Record<string, string | undefined>
): string {
  const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const bin of ["pwsh.exe", "powershell.exe"]) {
    for (const dir of dirs) {
      const candidate = path.join(dir, bin);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "powershell.exe";
}

/**
 * Resolves a command and arguments for safe cross-platform execution.
 * On Windows, npm global CLIs (`claude`, `codex`, `opencode`, `agy`, `npx`)
 * and Cursor CLI (`cursor-agent.ps1` / `agent.ps1`) are installed as `.cmd` or `.ps1` shims,
 * which throw ENOENT when spawned with `shell: false`, or break on multiline prompts
 * when spawned with `shell: true`.
 */
export function resolveSpawnCommand(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; shell: boolean } {
  if (platform !== "win32") {
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
    } else if (fs.existsSync(`${cmd}.exe`)) {
      return { command: `${cmd}.exe`, args, shell: false };
    } else if (fs.existsSync(`${cmd}.cmd`)) {
      resolvedPath = `${cmd}.cmd`;
    } else if (fs.existsSync(`${cmd}.bat`)) {
      resolvedPath = `${cmd}.bat`;
    } else if (fs.existsSync(`${cmd}.ps1`)) {
      resolvedPath = `${cmd}.ps1`;
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
      const ps1Candidate = path.join(dir, `${cmd}.ps1`);
      if (fs.existsSync(ps1Candidate)) {
        resolvedPath = ps1Candidate;
        break;
      }
    }
  }

  if (resolvedPath && /\.ps1$/i.test(resolvedPath)) {
    const pwsh = findPowerShellExecutable(env);
    return {
      command: pwsh,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolvedPath,
        ...args,
      ],
      shell: false,
    };
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
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  harness: HarnessId;
  initialHarnessSessionId?: string | null;
  logPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  allowSlidingTimeout?: boolean;
  commandRunner?: CommandRunner;
  stdinPayload?: string;
  closeStdinOnSpawn?: boolean;
  promptFilePath?: string;
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
    timeoutReason?: "idle" | "wall_clock";
    status: "done" | "failed";
    errorSummary?: string;
    telemetry?: TaskTelemetry;
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
  timeoutReason?: "idle" | "wall_clock";
  status: "done" | "failed";
  errorSummary?: string;
  telemetry?: TaskTelemetry;
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
  const maxCeilingMs = options.maxDurationMs ?? DEFAULT_MAX_WALL_TIMEOUT_MS;
  const slidingEnabled = options.allowSlidingTimeout === true;

  return new Promise<ExecuteHarnessProcessResult>((resolve) => {
    let pid = 0;
    let settled = false;
    let runnerSettled = false;
    let killRequested = false;
    let timedOut = false;
    let timeoutReason: "idle" | "wall_clock" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionDetectBuffer = "";
    let telemetryBuffer = "";
    let telemetry: TaskTelemetry | undefined;
    const runnerAbortController = new AbortController();

    const consumeTelemetryLine = (rawLine: string): void => {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const extracted = extractTelemetryFromJsonEvent(parsed, options.harness);
        if (extracted) {
          telemetry = mergeTaskTelemetry(
            telemetry,
            extracted,
            isAccumulativeStepEvent(parsed) ? "accumulate" : "replace"
          );
        }
      } catch {
        // Best-effort: ignore non-JSON lines
      }
    };

    const finish = (
      exitCode: number,
      status: "done" | "failed",
      errorSummary?: string
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
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
      if (telemetryBuffer.length > 0) {
        consumeTelemetryLine(telemetryBuffer.replace(/\r$/, ""));
        telemetryBuffer = "";
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
        ...(timeoutReason ? { timeoutReason } : {}),
        status,
        errorSummary,
        ...(telemetry ? { telemetry } : {}),
      };
      options.onBeforeStreamEnd?.(result);
      if (options.promptFilePath) {
        try {
          const tmpParent = path.dirname(options.promptFilePath);
          if (path.basename(tmpParent).startsWith("asd-prompt-")) {
            fs.rmSync(tmpParent, { recursive: true, force: true });
          } else {
            fs.rmSync(options.promptFilePath, { force: true });
          }
        } catch {
          // Best-effort temp prompt cleanup
        }
      }
      logStream.end(() => {
        resolve(result);
      });
    };

    const requestKill = (): void => {
      killRequested = true;
      runnerAbortController.abort();
      if (pid > 0) killProcessTree(pid);
    };

    const onAbort = (): void => {
      requestKill();
      if (runnerSettled) {
        finish(-1, "failed");
        return;
      }
      // Wait up to 250ms grace window for child close event after killProcessTree
      if (graceTimer === undefined) {
        graceTimer = setTimeout(() => {
          finish(-1, "failed");
        }, 250);
        graceTimer.unref?.();
      }
    };

    const onHardTimeout = (): void => {
      timedOut = true;
      timeoutReason = "wall_clock";
      handleChunk(
        `[TIMEOUT] Process exceeded timeout (${effectiveTimeoutMs}ms)\n`
      );
      onAbort();
    };

    const onIdleTimeout = (): void => {
      timedOut = true;
      timeoutReason = "idle";
      handleChunk(
        `[IDLE_TIMEOUT] Process produced no output for ${options.idleTimeoutMs}ms\n`
      );
      onAbort();
    };

    const resetIdleTimer = (): void => {
      if (options.idleTimeoutMs === undefined || settled || killRequested) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdleTimeout, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const slideWallTimer = (): void => {
      if (
        !slidingEnabled ||
        effectiveTimeoutMs === undefined ||
        settled ||
        killRequested
      ) {
        return;
      }
      const elapsed = Date.now() - startedAt;
      const remainingCeiling = maxCeilingMs - elapsed;
      if (remainingCeiling <= 0) {
        onHardTimeout();
        return;
      }
      const nextWindow = Math.min(effectiveTimeoutMs, remainingCeiling);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(onHardTimeout, nextWindow);
      timer.unref?.();
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
        if (!killRequested) {
          resetIdleTimer();
          slideWallTimer();
        }
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
        telemetryBuffer += chunk;
        let tNlIdx = telemetryBuffer.indexOf("\n");
        while (tNlIdx !== -1) {
          const tLine = telemetryBuffer.slice(0, tNlIdx).replace(/\r$/, "");
          telemetryBuffer = telemetryBuffer.slice(tNlIdx + 1);
          consumeTelemetryLine(tLine);
          tNlIdx = telemetryBuffer.indexOf("\n");
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
        signal: runnerAbortController.signal,
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
          runnerSettled = true;
          if (pid === 0 && result.pid > 0) {
            pid = result.pid;
          }
          if (killRequested) {
            finish(-1, "failed");
            return;
          }
          finish(result.exitCode, result.exitCode === 0 ? "done" : "failed");
        },
        (err) => {
          runnerSettled = true;
          if (killRequested) {
            finish(-1, "failed");
            return;
          }
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

  fs.writeFileSync(path.join(sessionDir, "prompt.md"), redactSecrets(options.prompt));

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
    allowSlidingTimeout: options.allowSlidingTimeout,
    commandRunner: options.commandRunner,
    stdinPayload: options.stdinPayload,
    closeStdinOnSpawn: options.closeStdinOnSpawn ?? true,
    promptFilePath: options.promptFilePath,
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
    ...(res.timeoutReason ? { timeoutReason: res.timeoutReason } : {}),
    ...(res.telemetry ? { telemetry: res.telemetry } : {}),
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
