/**
 * OpenCode Harness Adapter (@oc)
 *
 * Implements HarnessAdapter for OpenCode CLI with OpenCode V2 as the canonical
 * first-class implementation (delegating to `./opencode-v1.ts` only for V1/`unknown`):
 * - Headless CLI execution via `opencode run "<prompt>" --format json --model <model>`
 * - PreToolUse hook denial via exit code 2 / stderr & stdout JSON
 * - Stop hook block via stdout JSON `{"decision":"block","reason":"..."}`
 * - V2 plugin (`plugins/asd-guard/index.js`) and V1 compatibility fallback (`plugin/asd-guard.js`)
 * - Global target paths under `<homeDir>/.config/opencode/`
 */

import * as path from "node:path";
import { killProcessTree } from "../core/spawner.ts";
import {
  AGENT_ROLES,
  ASD_VERSION,
  type HarnessAdapter,
  type HarnessId,
  type OpenCodeCapabilityProfile,
} from "../core/types.ts";
import { ASD_SKILLS } from "./claude-code.ts";
import {
  OPENCODE_V1_PLUGIN_MARKER,
  OPENCODE_V1_PLUGIN_RELATIVE_PATH,
  generateOpencodeV1GuardPlugin,
} from "./opencode-v1.ts";

export {
  detectOpenCodeVersion,
  resolveOpenCodeCapabilityProfile,
  buildOpenCodeCapabilityProfile,
} from "../core/opencode-profile.ts";

export const OPENCODE_V2_PLUGIN_MARKER = "// ASD-MANAGED-OPENCODE-V2-PLUGIN";
export const OPENCODE_V2_PLUGIN_ID = "asd-policy-guard";
export const OPENCODE_V2_PLUGIN_RELATIVE_PATH = "plugins/asd-guard/index.js";

export interface OpencodeSessionAbortOptions {
  mode?: "cli" | "daemon-sse";
  isSharedDaemon?: boolean;
  pid?: number;
  abortController?: AbortController;
  serverUrl?: string;
  sessionId?: string;
  profile?: OpenCodeCapabilityProfile;
  serverAbortPathTemplate?: string;
}

export function abortOpencodeSession(options: OpencodeSessionAbortOptions): void {
  if (options.mode === "daemon-sse" || options.isSharedDaemon === true) {
    options.abortController?.abort();
    if (options.serverUrl && options.sessionId) {
      const base = options.serverUrl.replace(/\/+$/, "");
      const template =
        options.serverAbortPathTemplate ??
        (options.profile?.effectiveProfile === "v2"
          ? options.profile.serverAbortPathTemplate || "/api/session/{sessionId}/interrupt"
          : options.profile?.serverAbortPathTemplate || "/session/{sessionId}/abort");
      const normalizedTemplate = template.startsWith("/") ? template : `/${template}`;
      const abortPath = normalizedTemplate.replace("{sessionId}", options.sessionId);
      try {
        void fetch(`${base}${abortPath}`, {
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
 * Generates the canonical ASD-managed OpenCode V2 guard plugin (`plugins/asd-guard/index.js`).
 *
 * Uses zero external npm imports (only `"node:child_process"` and `"node:fs"`) and bakes in
 * the resolved Node.js executable path (falling back to `"node"` when generated from a Bun
 * `opencode.exe` binary) so `spawnSync` never inadvertently invokes OpenCode itself.
 */
export function generateOpencodeV2GuardPlugin(
  asdCliPath: string,
  nodeExecPath: string = process.execPath
): string {
  const normalizedCliPath = asdCliPath.replaceAll("\\", "/");
  const trimmedNodePath = nodeExecPath.trim();
  const isNodeExec = /(?:^|[\\/])node(?:\.exe)?$/i.test(trimmedNodePath);
  const normalizedNodeBin = isNodeExec ? trimmedNodePath.replaceAll("\\", "/") : "node";
  return `${OPENCODE_V2_PLUGIN_MARKER} (v${ASD_VERSION})
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const ASD_CLI_PATH = ${JSON.stringify(normalizedCliPath)};
const ASD_NODE_BIN = ${JSON.stringify(normalizedNodeBin)};

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

export const AsdV2PolicyGuardPlugin = {
  id: ${JSON.stringify(OPENCODE_V2_PLUGIN_ID)},
  async setup(ctx) {
    const rootDir = ctx?.location?.directory || process.cwd();
    if (typeof ctx?.tool?.hook === "function") {
      await ctx.tool.hook("execute.before", (event) => {
        const res = runAsdHook("pre-tool-use", {
          tool_name: event?.tool ?? "",
          tool_input: event?.input ?? {},
          cwd: rootDir,
          session_id: event?.sessionID,
        });
        if (res.status && res.status !== 0) {
          const reason = (res.stderr || res.stdout || "Blocked by ASD PreToolUse policy").trim();
          throw new Error(reason);
        }
      });
    }
    const controller = new AbortController();
    if (typeof ctx?.event?.subscribe === "function") {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (controller.signal.aborted) break;
            if (event?.type === "session.idle") {
              const sessionId =
                event?.properties?.sessionID ??
                event?.sessionID ??
                event?.data?.sessionID;
              runAsdHook("stop", {
                session_id: sessionId,
                cwd: rootDir,
              });
            }
          }
        } catch {
          // AbortError or stream closed during plugin unload
        }
      })();
    }
    return () => {
      controller.abort();
    };
  },
};

export default AsdV2PolicyGuardPlugin;
`;
}

/**
 * Selects and generates the appropriate OpenCode guard plugin (V2 or frozen V1 fallback)
 * based on the detected capability profile.
 */
export function generateOpencodePluginForProfile(
  profile: OpenCodeCapabilityProfile,
  asdCliPath: string,
  nodeExecPath: string = process.execPath
): {
  relativePath: string;
  content: string;
  marker: string;
  profile: "v1" | "v2";
} {
  if (profile.effectiveProfile === "v2") {
    return {
      relativePath: OPENCODE_V2_PLUGIN_RELATIVE_PATH,
      content: generateOpencodeV2GuardPlugin(asdCliPath, nodeExecPath),
      marker: OPENCODE_V2_PLUGIN_MARKER,
      profile: "v2",
    };
  }
  return {
    relativePath: OPENCODE_V1_PLUGIN_RELATIVE_PATH,
    content: generateOpencodeV1GuardPlugin(asdCliPath, nodeExecPath),
    marker: OPENCODE_V1_PLUGIN_MARKER,
    profile: "v1",
  };
}

/**
 * Legacy OpenCode V1 guard plugin generator (delegated to frozen V1 compatibility module).
 */
export { generateOpencodeV1GuardPlugin as generateOpencodeGuardPlugin } from "./opencode-v1.ts";

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

  globalConfigTargets(homeDir: string, profile?: OpenCodeCapabilityProfile): string[] {
    const targets: string[] = [];
    const baseDir = path.join(homeDir, ".config", "opencode");

    targets.push(path.join(baseDir, "opencode.json"));
    const pluginRelPath =
      profile?.effectiveProfile === "v2"
        ? OPENCODE_V2_PLUGIN_RELATIVE_PATH
        : OPENCODE_V1_PLUGIN_RELATIVE_PATH;
    targets.push(path.join(baseDir, ...pluginRelPath.split("/")));
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
