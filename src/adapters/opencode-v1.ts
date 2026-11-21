/**
 * ============================================================================
 * FROZEN COMPATIBILITY MODULE — OpenCode V1 Legacy Guard Plugin
 * ============================================================================
 * Policy:
 * - NO new features may be added to this module.
 * - Security/critical fixes and shared-code compatibility fixes ONLY.
 * - Slated for full deletion in Phase 5 upon OpenCode V1 EOL or single-digit
 *   usage trigger.
 * - Active OpenCode V2 work must live outside this module (`opencode.ts` / V2).
 * ============================================================================
 */

import { ASD_VERSION } from "../core/types.ts";

export const OPENCODE_V1_PLUGIN_MARKER = "// ASD-MANAGED-OPENCODE-PLUGIN";
export const OPENCODE_V1_PLUGIN_RELATIVE_PATH = "plugin/asd-guard.js";

/**
 * Generates an ASD-managed OpenCode V1 plugin (`~/.config/opencode/plugin/asd-guard.js`)
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
export function generateOpencodeV1GuardPlugin(
  asdCliPath: string,
  nodeExecPath: string = process.execPath,
  pollIntervalMs: number = 1000
): string {
  const normalizedCliPath = asdCliPath.replaceAll("\\", "/");
  const isNodeExec = /(?:^|[\\/])node(?:\.exe)?$/i.test(nodeExecPath.trim());
  const normalizedNodeBin = isNodeExec ? nodeExecPath.replaceAll("\\", "/") : "node";
  const safePollMs = Math.max(20, Math.floor(pollIntervalMs));
  return `${OPENCODE_V1_PLUGIN_MARKER} (v${ASD_VERSION})
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
