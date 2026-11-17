/**
 * OpenCode Harness Adapter (@oc)
 *
 * Implements HarnessAdapter for OpenCode CLI:
 * - Headless CLI execution via `opencode run "<prompt>" --format json --model <model>`
 * - PreToolUse hook denial via exit code 2 / stderr & stdout JSON
 * - Stop hook block via stdout JSON `{"decision":"block","reason":"..."}`
 * - Global target paths under `<homeDir>/.config/opencode/`
 */

import * as path from "node:path";
import { killProcessTree } from "../core/spawner.ts";
import { AGENT_ROLES, ASD_VERSION, type HarnessAdapter, type HarnessId } from "../core/types.ts";
import { ASD_SKILLS } from "./claude-code.ts";

export interface OpencodeSessionAbortOptions {
  mode?: "cli" | "daemon-sse";
  isSharedDaemon?: boolean;
  pid?: number;
  abortController?: AbortController;
  serverUrl?: string;
  sessionId?: string;
}

export function abortOpencodeSession(options: OpencodeSessionAbortOptions): void {
  if (options.mode === "daemon-sse" || options.isSharedDaemon === true) {
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

export interface OpencodeDaemonShutdownOptions {
  pid: number;
  ownedByAsd?: boolean;
  activeSubagents?: number;
}

export function shutdownOpencodeDaemon(options: OpencodeDaemonShutdownOptions): boolean {
  if (options.ownedByAsd === true && (options.activeSubagents ?? 0) <= 0) {
    if (options.pid > 0) {
      killProcessTree(options.pid);
      return true;
    }
  }
  return false;
}

/**
 * Creates OpenCode configuration payload with MCP server catalog and optional routing config.
 */
export function createOpencodeConfig(
  mcpServers: Record<string, unknown>,
  routingConfig?: Record<string, unknown>
): Record<string, unknown> {
  return {
    _asdVersion: ASD_VERSION,
    mcpServers: { ...mcpServers },
    ...(routingConfig ? { agentRouting: routingConfig } : {}),
  };
}

/**
 * Generates an ASD-managed OpenCode plugin (`~/.config/opencode/plugin/asd-guard.js`)
 * that wires:
 * 1. OpenCode's `"tool.execute.before"` and `"session.idle"` events to
 *    `asd hook pre-tool-use` and `asd hook stop`.
 * 2. Non-blocking async dispatch completion delivery: captures the active OpenCode
 *    `sessionID`, watches `<directory>/.asd/sessions/<sessionId>/async-dispatch.json`, and when a
 *    detached wave transitions to `"done"` or `"failed"`, marks `notified = true` and
 *    pushes the completion report back into the OpenCode session via `client.session.prompt(...)`.
 *
 * IMPORTANT: OpenCode is distributed as a standalone Bun executable (`opencode` / `opencode.exe`),
 * so inside the plugin runtime `process.execPath` points to `opencode.exe` rather than `node`.
 * Spawning `process.execPath` with `--no-warnings <asdCliPath>` invokes `opencode` itself,
 * which prints the OpenCode CLI help text and exits with code 1, blocking every tool call.
 * We therefore bake in the Node.js binary path from sync time (with a runtime fallback to `"node"`).
 */
export function generateOpencodeGuardPlugin(
  asdCliPath: string,
  nodeExecPath: string = process.execPath,
  pollIntervalMs: number = 1000
): string {
  const normalizedCliPath = asdCliPath.replaceAll("\\", "/");
  const isNodeExec = /(?:^|[\\/])node(?:\.exe)?$/i.test(nodeExecPath.trim());
  const normalizedNodeBin = isNodeExec ? nodeExecPath.replaceAll("\\", "/") : "node";
  const safePollMs = Math.max(20, Math.floor(pollIntervalMs));
  return `// ASD-MANAGED-OPENCODE-PLUGIN (v${ASD_VERSION})
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ASD_CLI_PATH = ${JSON.stringify(normalizedCliPath)};
const ASD_NODE_BIN = ${JSON.stringify(normalizedNodeBin)};
const ASD_ASYNC_POLL_MS = ${safePollMs};

function resolveNodeExecutable() {
  if (ASD_NODE_BIN !== "node" && fs.existsSync(ASD_NODE_BIN)) {
    return ASD_NODE_BIN;
  }
  if (typeof process.execPath === "string" && /(?:^|[\\\\/])node(?:\\.exe)?$/i.test(process.execPath)) {
    return process.execPath;
  }
  return "node";
}

function runAsdHook(hookName, payload) {
  if (!fs.existsSync(ASD_CLI_PATH)) {
    return { status: 0, stdout: "", stderr: "" };
  }
  return spawnSync(
    resolveNodeExecutable(),
    ["--no-warnings", ASD_CLI_PATH, "hook", hookName, "--harness", "opencode"],
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    }
  );
}

function writeJsonAtomic(filePath, data) {
  const serialized = JSON.stringify(data, null, 2) + "\\n";
  const tmpPath = \`\${filePath}.tmp.\${process.pid}.\${Date.now()}\`;
  try {
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    fs.writeFileSync(filePath, serialized, "utf8");
  }
}

function formatAsyncCompletionReport(job) {
  const statusTag = job.status === "done" ? "DONE" : "FAILED";
  const lines = [
    \`[ASD Async Dispatch \${statusTag}] Turn \${job.turn} (\${job.sessionId})\`,
  ];
  if (typeof job.summary === "string" && job.summary.trim()) {
    lines.push(job.summary.trim());
  }
  if (typeof job.error === "string" && job.error.trim()) {
    lines.push(\`Error: \${job.error.trim()}\`);
  }
  if (typeof job.progressBoard === "string" && job.progressBoard.trim()) {
    lines.push("", job.progressBoard.trim());
  }
  return lines.join("\\n");
}

function isLikelyAsdDispatchTool(toolName, toolInput) {
  const lowerName = String(toolName || "").toLowerCase();
  if (lowerName.includes("asd_dispatch") || lowerName.includes("asd-dispatch")) {
    return true;
  }
  const cmd =
    typeof toolInput?.command === "string"
      ? toolInput.command
      : typeof toolInput?.cmd === "string"
        ? toolInput.cmd
        : "";
  return /\\basd\\b[\\s\\S]*\\bdispatch\\b/i.test(cmd);
}

export const AsdPolicyGuardPlugin = async ({ client, directory } = {}) => {
  const rootDir = directory || process.cwd();
  let activeSessionId = null;
  let sessionBusy = false;
  let pollTimer = null;
  let flushing = false;

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const scanAndNotifyCompletedJobs = async () => {
    if (flushing) return;
    flushing = true;
    try {
      const sessionsDir = path.join(rootDir, ".asd", "sessions");
      if (!fs.existsSync(sessionsDir)) {
        stopPolling();
        return;
      }

      let entries = [];
      try {
        entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      } catch {
        return;
      }

      let keepPolling = false;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const jobPath = path.join(sessionsDir, entry.name, "async-dispatch.json");
        if (!fs.existsSync(jobPath)) continue;

        let job = null;
        try {
          job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        } catch {
          keepPolling = true;
          continue;
        }
        if (!job || typeof job !== "object") continue;

        if (job.status === "running") {
          keepPolling = true;
          continue;
        }

        if ((job.status === "done" || job.status === "failed") && job.notified !== true) {
          const targetSessionId =
            (typeof job.openCodeSessionId === "string" && job.openCodeSessionId.trim()) ||
            activeSessionId;

          if (!targetSessionId || typeof client?.session?.prompt !== "function") {
            keepPolling = true;
            continue;
          }

          if (sessionBusy) {
            keepPolling = true;
            continue;
          }

          const attempts = typeof job.notifyAttempts === "number" ? job.notifyAttempts + 1 : 1;
          const claimedJob = {
            ...job,
            notified: true,
            notifiedAt: Date.now(),
            notifyAttempts: attempts,
            openCodeSessionId: targetSessionId,
          };
          try {
            writeJsonAtomic(jobPath, claimedJob);
          } catch {
            keepPolling = true;
            continue;
          }

          try {
            await client.session.prompt({
              path: { id: targetSessionId },
              body: {
                noReply: false,
                parts: [{ type: "text", text: formatAsyncCompletionReport(claimedJob) }],
              },
            });
          } catch {
            if (attempts < 3) {
              try {
                writeJsonAtomic(jobPath, {
                  ...claimedJob,
                  notified: false,
                });
                keepPolling = true;
              } catch {
                // ignore rollback write failure
              }
            }
          }
        }
      }

      if (!keepPolling) {
        stopPolling();
      }
    } finally {
      flushing = false;
    }
  };

  const ensurePolling = () => {
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void scanAndNotifyCompletedJobs();
      }, ASD_ASYNC_POLL_MS);
      if (pollTimer && typeof pollTimer.unref === "function") {
        pollTimer.unref();
      }
    }
  };

  if (fs.existsSync(path.join(rootDir, ".asd", "sessions"))) {
    ensurePolling();
  }

  return {
    "tool.execute.before": async (input, output) => {
      const toolArgs = output?.args ?? input?.args ?? {};
      if (typeof input?.sessionID === "string" && input.sessionID.trim()) {
        activeSessionId = input.sessionID.trim();
      }
      const res = runAsdHook("pre-tool-use", {
        tool_name: input?.tool ?? "",
        tool_input: toolArgs,
        cwd: rootDir,
        session_id: input?.sessionID,
      });
      if (res.status && res.status !== 0) {
        const reason = (res.stderr || res.stdout || "Blocked by ASD PreToolUse policy").trim();
        throw new Error(reason);
      }
      if (
        isLikelyAsdDispatchTool(input?.tool, toolArgs) ||
        fs.existsSync(path.join(rootDir, ".asd", "sessions"))
      ) {
        ensurePolling();
      }
    },
    event: async ({ event } = {}) => {
      const propSid =
        event?.properties?.sessionID ??
        event?.properties?.info?.id ??
        null;
      if (typeof propSid === "string" && propSid.trim()) {
        activeSessionId = propSid.trim();
      }

      if (event?.type === "session.status") {
        const stType = event?.properties?.status?.type;
        if (stType === "busy") {
          sessionBusy = true;
        } else if (stType === "idle") {
          sessionBusy = false;
          await scanAndNotifyCompletedJobs();
        }
        return;
      }

      if (event?.type === "session.idle") {
        sessionBusy = false;
        runAsdHook("stop", {
          session_id: event?.properties?.sessionID,
          cwd: rootDir,
        });
        await scanAndNotifyCompletedJobs();
      }
    },
  };
};

export default AsdPolicyGuardPlugin;
`;
}

export class OpencodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "opencode";
  readonly supportsHeadlessSpawn: boolean = true;

  abortSession(options: OpencodeSessionAbortOptions): void {
    abortOpencodeSession(options);
  }

  shutdownDaemon(options: OpencodeDaemonShutdownOptions): boolean {
    return shutdownOpencodeDaemon(options);
  }

  formatPreToolUseDeny(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    return {
      exitCode: 2,
      stderr: reason,
      stdout: JSON.stringify({ decision: "deny", reason }),
    };
  }

  formatStopBlock(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason }),
    };
  }

  globalConfigTargets(homeDir: string): string[] {
    const targets: string[] = [];
    const baseDir = path.join(homeDir, ".config", "opencode");

    targets.push(path.join(baseDir, "opencode.json"));
    targets.push(path.join(baseDir, "plugin", "asd-guard.js"));
    for (const role of AGENT_ROLES) {
      targets.push(path.join(baseDir, "agent", `asd-${role}.md`));
    }
    for (const skill of ASD_SKILLS) {
      targets.push(path.join(baseDir, "command", `${skill}.md`));
    }
    targets.push(path.join(baseDir, "AGENTS.md"));

    return targets;
  }
}

export const opencodeAdapter: HarnessAdapter = new OpencodeAdapter();
