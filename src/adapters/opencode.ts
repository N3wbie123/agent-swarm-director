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

export class OpencodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "opencode";
  readonly supportsHeadlessSpawn: boolean = true;

  buildHeadlessCommand(
    prompt: string,
    model: string,
    _opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] } {
    const args: string[] = ["run", prompt, "--format", "json"];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: "opencode", args };
  }

  buildResumeCommand(
    harnessSessionId: string,
    prompt: string,
    model?: string
  ): { cmd: string; args: string[] } {
    const args: string[] = [
      "run",
      prompt,
      "--session",
      harnessSessionId,
      "--format",
      "json",
    ];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: "opencode", args };
  }

  buildInteractiveResumeCommand(
    harnessSessionId: string,
    model?: string
  ): { cmd: string; args: string[] } {
    const args: string[] = harnessSessionId ? ["--session", harnessSessionId] : [];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: "opencode", args };
  }

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
