/**
 * ASD Pure Agent Client Protocol (ACP) Client Engine (src/core/acp-client.ts)
 *
 * Implements:
 * 1. Per-harness ACP readiness probing & spawn command resolution (`probeAcpCapability`,
 *    `resolveAcpLaunchCommand`), handling Windows `.ps1` / `.cmd` / `.exe` shims safely.
 * 2. Zero-dependency newline-delimited JSON-RPC 2.0 `AcpStdioClient` over `child_process`:
 *    - `initialize` handshake (ACP v1 default + v2 compatibility negotiation, `clientCapabilities: {}`).
 *    - `session/new` and `session/load` (resume) with best-effort `session/set_model` /
 *      `session/set_config_option` model & thinking effort configuration.
 *    - Unified `promptTurn`: supports both ACP v1 synchronous `session/prompt` + live
 *      `session/update` chunks AND ACP v2 draft immediate ACK + async `session/update` idle completion.
 *    - Cooperative `session/cancel` notification + clean process-tree teardown.
 * 3. Bidirectional `session/request_permission` security gate (`evaluateAcpPermissionRequest`):
 *    - Enforces read-only roles (`scout`, `critic`), `allowedFiles` boundaries, protected paths
 *      (`.git/`, `.asd/`, `.env*`, `*.pem`, `*.key`), and shell command guards via `policy.ts`.
 *
 * Invariants:
 * - Strict Core Purity: ZERO imports from ../adapters, ../mcp, or ../cli.
 * - Zero external runtime npm dependencies.
 * - Erasable TypeScript only.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AcpContentBlock,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpNormalizedEvent,
  AcpPermissionOption,
  AcpPolicyContext,
  AcpProtocolVersion,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionCancelParams,
  AcpSessionConfigOption,
  AcpSessionLoadParams,
  AcpSessionModelInfo,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionSetConfigOptionParams,
  AcpSessionSetModelParams,
  AcpSessionUpdateParams,
  AcpSessionUpdatePayload,
  AcpStopReason,
  AcpTurnExecutionResult,
  JsonRpcId,
} from "./acp-types.ts";
import {
  checkProtectedPath,
  evaluatePreToolUse,
  resolveSafeTargetPath,
  verifyChangedFilesBoundary,
} from "./policy.ts";
import { redactSecrets } from "./redact.ts";
import { resolveBinaryOnPath } from "./router.ts";
import { killProcessTree } from "./spawner.ts";
import {
  ASD_VERSION,
  type AcpHarnessReadiness,
  type AgentRole,
  type HarnessId,
} from "./types.ts";

// ============================================================================
// 1. Harness ACP Capability Discovery & Cross-Platform Executable Resolver
// ============================================================================

function stripModelBrackets(id: string): string {
  return id.replace(/\[.*\]$/, "").trim();
}

function normalizeModelSlug(id: string): string {
  return stripModelBrackets(id)
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/(\d)p(\d)/g, "$1.$2")
    .replace(/[^a-z0-9]/g, "");
}

function pickBestEffortVariant(candidates: string[], effort: string): string {
  if (candidates.length <= 1 || !effort) return candidates[0]!;
  const effRe = new RegExp(`(?:^|[,_=-])${effort}(?:[,\\]$]|$)`, "i");
  return candidates.find((c) => effRe.test(c)) ?? candidates[0]!;
}

export function matchAcpModelCandidate(
  requestedModel: string,
  candidates: readonly string[],
  thinkingEffort?: string | null
): string | null {
  const reqTrimmed = requestedModel.trim();
  if (!reqTrimmed || candidates.length === 0) return null;
  const reqLower = reqTrimmed.toLowerCase();

  // 1. Exact case-insensitive match
  const exact = candidates.find((c) => c.toLowerCase() === reqLower);
  if (exact) return exact;

  // 2. Antigravity tier shorthands (flash_lite, flash, pro)
  if (reqLower === "flash_lite" || reqLower === "flash-lite") {
    return (
      candidates.find((c) => /gemini-3\.8-flash-low/i.test(c)) ??
      candidates.find((c) => /flash-(?:low|lite)/i.test(c)) ??
      candidates.find((c) => /flash/i.test(c)) ??
      null
    );
  }
  if (reqLower === "flash") {
    return (
      candidates.find((c) => /gemini-3\.8-flash-medium/i.test(c)) ??
      candidates.find((c) => /gemini-3\.8-flash(?:\[|$)/i.test(c)) ??
      candidates.find((c) => /flash/i.test(c)) ??
      null
    );
  }
  if (reqLower === "pro") {
    return (
      candidates.find((c) => /gemini-4-carbon-high/i.test(c)) ??
      candidates.find((c) => /gemini-4-carbon/i.test(c)) ??
      candidates.find((c) => /\bpro\b|-pro(?:\[|-|$)/i.test(c)) ??
      null
    );
  }

  const reqNoBracket = stripModelBrackets(reqLower);
  const effortSuffixMatch = reqNoBracket.match(/^(.*?)-(low|medium|high|xhigh|max)$/);
  const reqBase = effortSuffixMatch ? effortSuffixMatch[1]! : reqNoBracket;
  const effectiveEffort =
    thinkingEffort?.trim().toLowerCase() || effortSuffixMatch?.[2] || "medium";

  // 3. Base + effort suffix match (e.g. 'gemini-3.8-flash' -> 'gemini-3.8-flash-medium')
  const withEffort = `${reqBase}-${effectiveEffort}`;
  const exactEffort = candidates.find((c) => c.toLowerCase() === withEffort);
  if (exactEffort) return exactEffort;

  // 4. Provider-prefixed suffix match (e.g. 'z-ai/glm-5.3-flash' -> 'nvidia/z-ai/glm-5.3-flash')
  const providerMatches = candidates.filter((c) => {
    const baseC = stripModelBrackets(c).toLowerCase();
    return (
      baseC === reqNoBracket ||
      baseC.endsWith(`/${reqNoBracket}`) ||
      baseC.endsWith(`/${reqBase}`)
    );
  });
  if (providerMatches.length > 0) {
    return pickBestEffortVariant(providerMatches, effectiveEffort);
  }

  // 5. Bracket-stripped base match (e.g. Cursor 'claude-sonnet-5-5[context=300k,...]' for 'claude-sonnet-5-5-medium')
  const baseMatches = candidates.filter((c) => {
    const baseC = stripModelBrackets(c).toLowerCase();
    return baseC === reqBase || baseC.startsWith(`${reqBase}-`);
  });
  if (baseMatches.length > 0) {
    return pickBestEffortVariant(baseMatches, effectiveEffort);
  }

  // 6. Normalized slug match (e.g. 'z-ai/glm-5.3-flash' -> 'glm-5p3-flash[reasoning=high]', 'deepseek-v4.1-flash' -> 'deepseek-v41-flash-1017[...]')
  const reqSlug = normalizeModelSlug(reqBase);
  if (reqSlug.length >= 5) {
    const slugExact = candidates.filter((c) => normalizeModelSlug(c) === reqSlug);
    if (slugExact.length > 0) {
      return pickBestEffortVariant(slugExact, effectiveEffort);
    }
    const slugPrefix = candidates.filter((c) =>
      normalizeModelSlug(c).startsWith(reqSlug)
    );
    if (slugPrefix.length > 0) {
      return pickBestEffortVariant(slugPrefix, effectiveEffort);
    }
  }

  return null;
}

/**
 * Resolves the concrete ACP `set_model` and `set_config_option` model IDs from
 * `session/new` (or `session/load`) catalog metadata (`models.availableModels` & `configOptions`).
 */
export function resolveBestAcpModelId(
  requestedModel: string,
  catalog?: {
    availableModels?: AcpSessionModelInfo[];
    configOptions?: AcpSessionConfigOption[];
    thinkingEffort?: string | null;
  }
): {
  setModelId: string | null;
  configOptionId: string | null;
  configValue: string | null;
} {
  const cleanReq = requestedModel.trim();
  const modelIds = (catalog?.availableModels ?? [])
    .map((m) => m.modelId)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);

  const modelOpt = catalog?.configOptions?.find(
    (c) => c.id === "model" || c.category === "model"
  );
  const configIds = (modelOpt?.options ?? [])
    .map((o) => o.value)
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  const matchedSetModel =
    modelIds.length > 0
      ? matchAcpModelCandidate(cleanReq, modelIds, catalog?.thinkingEffort)
      : configIds.length > 0
        ? matchAcpModelCandidate(cleanReq, configIds, catalog?.thinkingEffort)
        : cleanReq;

  const matchedConfigValue =
    configIds.length > 0
      ? matchAcpModelCandidate(cleanReq, configIds, catalog?.thinkingEffort)
      : modelOpt
        ? cleanReq
        : null;

  return {
    setModelId: matchedSetModel,
    configOptionId: modelOpt?.id ?? null,
    configValue: matchedConfigValue,
  };
}

export const CLAUDE_ACP_INSTALL_HINT =
  "npm install -g @agentclientprotocol/claude-agent-acp" as const;
export const CODEX_ACP_INSTALL_HINT =
  "npm install -g @agentclientprotocol/codex-acp" as const;

/**
 * Probes whether ACP execution is available for a given harness on the current system.
 */
export function probeAcpCapability(
  harness: HarnessId,
  env: Record<string, string | undefined> = process.env,
  options?: { interactivePermissions?: boolean }
): AcpHarnessReadiness {
  switch (harness) {
    case "opencode": {
      const resolved = resolveBinaryOnPath("opencode", env);
      return {
        harness,
        supported: Boolean(resolved),
        mode: "native",
        command: "opencode",
        args: ["acp", "--pure"],
        resolvedPath: resolved,
      };
    }
    case "antigravity": {
      const resolved = resolveBinaryOnPath("agy", env);
      const args =
        options?.interactivePermissions === true
          ? ["acp"]
          : ["acp", "--dangerously-skip-permissions"];
      return {
        harness,
        supported: Boolean(resolved),
        mode: "native",
        command: "agy",
        args,
        resolvedPath: resolved,
      };
    }
    case "cursor": {
      const cursorAgent = resolveBinaryOnPath("cursor-agent", env);
      if (cursorAgent) {
        return {
          harness,
          supported: true,
          mode: "native",
          command: "cursor-agent",
          args: ["acp"],
          resolvedPath: cursorAgent,
        };
      }
      const agentBin = resolveBinaryOnPath("agent", env);
      return {
        harness,
        supported: Boolean(agentBin),
        mode: "native",
        command: "agent",
        args: ["acp"],
        resolvedPath: agentBin,
      };
    }
    case "claude-code": {
      const primary = resolveBinaryOnPath("claude-agent-acp", env);
      if (primary) {
        return {
          harness,
          supported: true,
          mode: "bridge",
          command: "claude-agent-acp",
          args: [],
          resolvedPath: primary,
        };
      }
      const legacy = resolveBinaryOnPath("claude-code-acp", env);
      if (legacy) {
        return {
          harness,
          supported: true,
          mode: "bridge",
          command: "claude-code-acp",
          args: [],
          resolvedPath: legacy,
        };
      }
      return {
        harness,
        supported: false,
        mode: "missing-bridge",
        command: "claude-agent-acp",
        args: [],
        resolvedPath: null,
        installHint: CLAUDE_ACP_INSTALL_HINT,
      };
    }
    case "codex": {
      const bridge = resolveBinaryOnPath("codex-acp", env);
      if (bridge) {
        return {
          harness,
          supported: true,
          mode: "bridge",
          command: "codex-acp",
          args: [],
          resolvedPath: bridge,
        };
      }
      return {
        harness,
        supported: false,
        mode: "missing-bridge",
        command: "codex-acp",
        args: [],
        resolvedPath: null,
        installHint: CODEX_ACP_INSTALL_HINT,
      };
    }
  }
}

/**
 * Resolves an executable command and arguments safely across Windows (`.exe`, `.cmd`, `.bat`, `.ps1`)
 * and POSIX without corrupting stdio JSON-RPC streams via interactive shells.
 */
export function resolveAcpLaunchCommand(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; shell: boolean } {
  if (platform !== "win32") {
    return { command: cmd, args, shell: false };
  }

  const lower = cmd.toLowerCase();
  if (lower === "node" || lower === "node.exe" || lower.endsWith(".exe")) {
    return { command: cmd, args, shell: false };
  }

  let resolvedPath = "";
  if (path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/")) {
    if (fs.existsSync(cmd)) {
      resolvedPath = cmd;
    } else {
      for (const ext of [".exe", ".cmd", ".bat", ".ps1"]) {
        if (fs.existsSync(`${cmd}${ext}`)) {
          resolvedPath = `${cmd}${ext}`;
          break;
        }
      }
    }
  } else {
    resolvedPath = resolveBinaryOnPath(cmd, env) ?? "";
  }

  if (resolvedPath) {
    if (/\.exe$/i.test(resolvedPath)) {
      return { command: resolvedPath, args, shell: false };
    }
    if (/\.ps1$/i.test(resolvedPath)) {
      const pwsh =
        resolveBinaryOnPath("pwsh", env) ??
        resolveBinaryOnPath("powershell", env) ??
        "powershell.exe";
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
    if (/\.(cmd|bat)$/i.test(resolvedPath)) {
      try {
        const shimContent = fs.readFileSync(resolvedPath, "utf8");
        const shimDir = path.dirname(resolvedPath);
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
        // Fall through to ComSpec invocation
      }
      const comspec = env.ComSpec || process.env.ComSpec || "cmd.exe";
      return {
        command: comspec,
        args: ["/d", "/s", "/c", resolvedPath, ...args],
        shell: false,
      };
    }
  }

  return { command: cmd, args, shell: false };
}

// ============================================================================
// 2. ACP Permission Gate (`session/request_permission` -> `policy.ts`)
// ============================================================================

function selectPermissionOption(
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
      options.find((o) => /allow|approve|accept|yes/i.test(`${o.optionId} ${o.kind} ${o.name}`)) ??
      options[0];
    if (picked) {
      return { outcome: { outcome: "selected", optionId: picked.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  const rejectPicked =
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => o.kind === "reject_always") ??
    options.find((o) => /reject|deny|block|cancel|no/i.test(`${o.optionId} ${o.kind} ${o.name}`));
  if (rejectPicked) {
    return { outcome: { outcome: "selected", optionId: rejectPicked.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function collectCandidatePaths(
  params: AcpRequestPermissionParams
): string[] {
  const paths: string[] = [];
  if (Array.isArray(params.toolCall?.locations)) {
    for (const loc of params.toolCall.locations) {
      if (loc && typeof loc.path === "string" && loc.path.trim()) {
        paths.push(loc.path.trim());
      }
    }
  }
  const rawIn = params.toolCall?.rawInput;
  if (rawIn && typeof rawIn === "object" && !Array.isArray(rawIn)) {
    const rec = rawIn as Record<string, unknown>;
    for (const key of [
      "file_path",
      "filePath",
      "path",
      "Path",
      "TargetFile",
      "target_file",
      "notebook_path",
    ]) {
      const v = rec[key];
      if (typeof v === "string" && v.trim()) {
        paths.push(v.trim());
      }
    }
  }
  return [...new Set(paths)];
}

function checkInteractivePermissionSafety(
  params: AcpRequestPermissionParams,
  cwd: string
): { safe: true } | { safe: false; reason: string } {
  const candidatePaths = collectCandidatePaths(params);
  for (const targetPath of candidatePaths) {
    const safeRes = resolveSafeTargetPath(targetPath, cwd);
    if (!safeRes.safe) {
      return {
        safe: false,
        reason: safeRes.reason ?? `Unsafe path '${targetPath}'`,
      };
    }
    const rel = safeRes.relativeToRoot ?? targetPath;
    const prot = checkProtectedPath(rel);
    if (prot.protected) {
      return {
        safe: false,
        reason: prot.reason ?? `Protected path '${rel}'`,
      };
    }
  }
  return { safe: true };
}

/**
 * Evaluates an incoming ACP `session/request_permission` request against ASD's
 * security policy (`allowedFiles`, protected paths, read-only role enforcement, and shell guards).
 */
export function evaluateAcpPermissionRequest(
  params: AcpRequestPermissionParams,
  policyCtx?: AcpPolicyContext
): {
  result: AcpRequestPermissionResult;
  allowed: boolean;
  reason?: string;
} {
  if (!policyCtx) {
    return {
      result: selectPermissionOption(params.options ?? [], true),
      allowed: true,
    };
  }

  const kind = (params.toolCall?.kind ?? "").toLowerCase();
  const title = (params.toolCall?.title ?? "").toLowerCase();
  const isReadOnlyRole = policyCtx.role === "scout" || policyCtx.role === "critic";
  const isMutatingKind =
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    /\b(?:write|edit|patch|delete|remove|create)\b/.test(title);

  if (isReadOnlyRole && isMutatingKind) {
    const reason = `Read-only role '${policyCtx.role}' is forbidden from modifying files`;
    return {
      result: selectPermissionOption(params.options ?? [], false),
      allowed: false,
      reason,
    };
  }

  const candidatePaths = collectCandidatePaths(params);
  for (const targetPath of candidatePaths) {
    const safeRes = resolveSafeTargetPath(targetPath, policyCtx.cwd);
    if (!safeRes.safe) {
      return {
        result: selectPermissionOption(params.options ?? [], false),
        allowed: false,
        reason: safeRes.reason ?? `Unsafe path '${targetPath}'`,
      };
    }
    const rel = safeRes.relativeToRoot ?? targetPath;
    const prot = checkProtectedPath(rel);
    if (prot.protected) {
      return {
        result: selectPermissionOption(params.options ?? [], false),
        allowed: false,
        reason: prot.reason ?? `Protected path '${rel}'`,
      };
    }
    if (isMutatingKind && policyCtx.allowedFiles.length > 0) {
      const boundary = verifyChangedFilesBoundary([rel], policyCtx.allowedFiles, policyCtx.cwd);
      if (!boundary.valid) {
        return {
          result: selectPermissionOption(params.options ?? [], false),
          allowed: false,
          reason: boundary.violations.join("; "),
        };
      }
    }
  }

  const rawInputObj =
    params.toolCall?.rawInput &&
    typeof params.toolCall.rawInput === "object" &&
    !Array.isArray(params.toolCall.rawInput)
      ? (params.toolCall.rawInput as Record<string, unknown>)
      : typeof params.toolCall?.rawInput === "string"
        ? { command: params.toolCall.rawInput }
        : {};

  const inferredToolName =
    kind === "execute" || typeof rawInputObj.command === "string"
      ? "bash"
      : isMutatingKind
        ? "write_file"
        : params.toolCall?.title || "tool";

  const effectiveEnv: Record<string, string | undefined> = {
    ...(policyCtx.env ?? process.env),
    ASD_PROJECT_ROOT: policyCtx.cwd,
    ...(policyCtx.metaPath
      ? { ASD_SESSION_ROLE: "subagent", ASD_SUBAGENT_META: policyCtx.metaPath }
      : {}),
  };

  if (policyCtx.metaPath && fs.existsSync(policyCtx.metaPath)) {
    const preRes = evaluatePreToolUse(
      {
        harness: policyCtx.harness,
        tool_name: inferredToolName,
        tool_input: rawInputObj,
        projectRoot: policyCtx.cwd,
      },
      undefined,
      effectiveEnv
    );
    if (!preRes.allowed) {
      return {
        result: selectPermissionOption(params.options ?? [], false),
        allowed: false,
        reason: preRes.reason,
      };
    }
  } else if (inferredToolName === "bash") {
    const preRes = evaluatePreToolUse(
      {
        harness: policyCtx.harness,
        tool_name: "bash",
        tool_input: rawInputObj,
        projectRoot: policyCtx.cwd,
      },
      undefined,
      { ...effectiveEnv, ASD_SESSION_ROLE: undefined, ASD_SUBAGENT_META: undefined }
    );
    if (!preRes.allowed) {
      return {
        result: selectPermissionOption(params.options ?? [], false),
        allowed: false,
        reason: preRes.reason,
      };
    }
  }

  return {
    result: selectPermissionOption(params.options ?? [], true),
    allowed: true,
  };
}

// ============================================================================
// 3. ACP `session/update` Normalization (v1 + v2 Draft Compatibility)
// ============================================================================

function extractContentBlockText(
  content: AcpContentBlock | AcpContentBlock[] | string | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (typeof rec.text === "string") return rec.text;
          if (rec.content && typeof rec.content === "object") {
            const inner = rec.content as Record<string, unknown>;
            if (typeof inner.text === "string") return inner.text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (rec.content && typeof rec.content === "object") {
      const inner = rec.content as Record<string, unknown>;
      if (typeof inner.text === "string") return inner.text;
    }
  }
  return "";
}

export function normalizeAcpSessionUpdate(
  params: AcpSessionUpdateParams,
  now = Date.now()
): AcpNormalizedEvent | null {
  const sid = typeof params.sessionId === "string" ? params.sessionId : "";
  const u: AcpSessionUpdatePayload =
    params.update && typeof params.update === "object"
      ? params.update
      : (params as unknown as AcpSessionUpdatePayload);

  const kind = u.sessionUpdate ?? u.type ?? "";

  if (kind === "agent_message_chunk" || kind === "message_chunk" || kind === "message_upsert") {
    const text =
      extractContentBlockText(u.content) ||
      (typeof u.delta === "string" ? u.delta : "") ||
      (typeof u.text === "string" ? u.text : "");
    if (!text) return null;
    return {
      category: "text",
      sessionId: sid,
      text,
      timestamp: now,
    };
  }

  if (kind === "agent_thought_chunk" || kind === "thought_chunk" || kind === "reasoning_chunk") {
    const thinking =
      extractContentBlockText(u.content) ||
      (typeof u.delta === "string" ? u.delta : "") ||
      (typeof u.text === "string" ? u.text : "");
    if (!thinking) return null;
    return {
      category: "thinking",
      sessionId: sid,
      thinking,
      timestamp: now,
    };
  }

  if (kind === "tool_call") {
    const toolInput =
      u.rawInput !== undefined
        ? typeof u.rawInput === "string"
          ? u.rawInput
          : JSON.stringify(u.rawInput)
        : undefined;
    return {
      category: "tool_use",
      sessionId: sid,
      toolCallId: u.toolCallId ?? u.id,
      toolName: u.title ?? u.kind ?? "tool",
      toolKind: u.kind,
      ...(toolInput !== undefined ? { toolInput } : {}),
      timestamp: now,
    };
  }

  if (kind === "tool_call_update") {
    const status = u.status ?? "";
    if (status === "completed" || status === "failed" || u.rawOutput !== undefined) {
      const outFromContent = extractContentBlockText(u.content);
      const rawOut =
        outFromContent ||
        (u.rawOutput !== undefined
          ? typeof u.rawOutput === "string"
            ? u.rawOutput
            : JSON.stringify(u.rawOutput)
          : "");
      return {
        category: "tool_result",
        sessionId: sid,
        toolCallId: u.toolCallId ?? u.id,
        toolName: u.title ?? u.kind,
        toolOutput: rawOut,
        ...(status === "failed" ? { isError: true } : {}),
        timestamp: now,
      };
    }
    return null;
  }

  const effectiveState = u.state ?? params.state;
  const effectiveStop = u.stopReason ?? params.stopReason;
  if (
    kind === "turn_complete" ||
    kind === "session_state" ||
    effectiveState === "idle" ||
    Boolean(effectiveStop)
  ) {
    return {
      category: "state",
      sessionId: sid,
      ...(effectiveStop ? { stopReason: effectiveStop } : { stopReason: "end_turn" }),
      timestamp: now,
    };
  }

  return null;
}

// ============================================================================
// 4. `AcpStdioClient` (Zero-Dependency JSON-RPC 2.0 Client + Server Handler)
// ============================================================================

export interface AcpStdioClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  policyContext?: AcpPolicyContext;
  preferredProtocolVersion?: AcpProtocolVersion;
  requestTimeoutMs?: number;
  onEvent?: (event: AcpNormalizedEvent) => void;
  onRawFrame?: (direction: "in" | "out" | "stderr", line: string) => void;
  onPermissionRequest?: (
    params: AcpRequestPermissionParams
  ) => Promise<AcpRequestPermissionResult>;
  onSpawn?: (pid: number) => void;
}

interface PendingRpcCall {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpStdioClient {
  private readonly opts: AcpStdioClientOptions;
  private child: child_process.ChildProcess | null = null;
  private stdoutBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRpcCall>();
  private readonly pendingPermissions = new Map<
    JsonRpcId,
    { sessionId: string; cancel: () => void }
  >();
  private readonly sessionCatalogs = new Map<
    string,
    {
      availableModels?: AcpSessionModelInfo[];
      configOptions?: AcpSessionConfigOption[];
    }
  >();
  private readonly stateWaiters = new Map<
    string,
    Array<(stopReason: AcpStopReason) => void>
  >();
  private closed = false;
  private exitPromise: Promise<number> | null = null;
  private negotiatedProtocolVersion = 1;
  private initResult: AcpInitializeResult | null = null;

  constructor(options: AcpStdioClientOptions) {
    this.opts = { ...options };
  }

  get pid(): number {
    return this.child?.pid ?? 0;
  }

  get isConnected(): boolean {
    return (
      !this.closed &&
      this.child !== null &&
      this.child.exitCode === null &&
      !this.child.killed
    );
  }

  get protocolVersion(): number {
    return this.negotiatedProtocolVersion;
  }

  get agentCapabilities(): AcpInitializeResult["agentCapabilities"] | undefined {
    return this.initResult?.agentCapabilities;
  }

  setTurnHandlers(handlers: {
    onEvent?: (event: AcpNormalizedEvent) => void;
    onRawFrame?: (direction: "in" | "out" | "stderr", line: string) => void;
    onPermissionRequest?: (
      params: AcpRequestPermissionParams
    ) => Promise<AcpRequestPermissionResult>;
  }): void {
    this.opts.onEvent = handlers.onEvent;
    this.opts.onRawFrame = handlers.onRawFrame;
    this.opts.onPermissionRequest = handlers.onPermissionRequest;
  }

  async connect(): Promise<AcpInitializeResult> {
    if (this.initResult) return this.initResult;

    const launch = resolveAcpLaunchCommand(
      this.opts.command,
      this.opts.args,
      this.opts.env ?? process.env
    );

    const child = child_process.spawn(launch.command, launch.args, {
      cwd: this.opts.cwd,
      env: (this.opts.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: launch.shell,
      detached: process.platform !== "win32",
    });

    this.child = child;
    this.opts.onSpawn?.(child.pid ?? 0);

    this.exitPromise = new Promise<number>((resolve) => {
      child.on("close", (code) => {
        this.rejectAllPending(
          new Error(`ACP process exited (code=${code ?? -1})`)
        );
        resolve(code ?? -1);
      });
      child.on("error", (err) => {
        this.rejectAllPending(err);
        resolve(-1);
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
    child.stderr?.on("data", (chunk: string) => {
      if (chunk.trim()) {
        this.opts.onRawFrame?.("stderr", chunk);
      }
    });

    const preferred = this.opts.preferredProtocolVersion ?? 1;
    const params: AcpInitializeParams = {
      protocolVersion: preferred,
      clientCapabilities: {},
      clientInfo: {
        name: "agent-swarm-director",
        title: "ASD Multi-Agent Orchestrator",
        version: ASD_VERSION,
      },
    };

    const res = (await this.sendRequest(
      "initialize",
      params,
      this.opts.requestTimeoutMs ?? 60_000
    )) as AcpInitializeResult;

    this.initResult = res;
    if (typeof res?.protocolVersion === "number" && res.protocolVersion >= 1) {
      this.negotiatedProtocolVersion = res.protocolVersion;
    }
    return res;
  }

  async startOrLoadSession(input: {
    cwd: string;
    resumeSessionId?: string | null;
    model?: string | null;
    thinkingEffort?: string | null;
  }): Promise<{ sessionId: string; loaded: boolean }> {
    let sessionId = "";
    let loaded = false;
    let availableModels: AcpSessionModelInfo[] | undefined;
    let configOptions: AcpSessionConfigOption[] | undefined;

    const resumeId = input.resumeSessionId?.trim();
    const caps = this.initResult?.agentCapabilities;
    const canLoad = Boolean(
      caps?.loadSession ||
        caps?.load_session ||
        caps?.sessionCapabilities?.load ||
        caps?.sessionCapabilities?.resume ||
        caps?.session_capabilities?.load ||
        caps?.session_capabilities?.resume
    );

    if (resumeId && canLoad) {
      const loadParams: AcpSessionLoadParams = {
        sessionId: resumeId,
        cwd: input.cwd,
        mcpServers: [],
      };
      const loadRes = (await this.sendRequest(
        "session/load",
        loadParams,
        this.opts.requestTimeoutMs ?? 60_000
      )) as Partial<AcpSessionNewResult> | null;
      sessionId =
        (typeof loadRes?.sessionId === "string" && loadRes.sessionId.trim()) ||
        resumeId;
      availableModels = loadRes?.models?.availableModels;
      configOptions = loadRes?.configOptions;
      loaded = true;
    } else {
      const newParams: AcpSessionNewParams = {
        cwd: input.cwd,
        mcpServers: [],
      };
      const created = (await this.sendRequest(
        "session/new",
        newParams,
        this.opts.requestTimeoutMs ?? 60_000
      )) as AcpSessionNewResult;
      if (!created || typeof created.sessionId !== "string" || !created.sessionId.trim()) {
        throw new Error("ACP session/new returned an invalid or empty sessionId");
      }
      sessionId = created.sessionId.trim();
      availableModels = created.models?.availableModels;
      configOptions = created.configOptions;
    }

    this.sessionCatalogs.set(sessionId, { availableModels, configOptions });
    await this.setSessionModel(sessionId, input.model ?? "", input.thinkingEffort);

    return { sessionId, loaded };
  }

  async setSessionModel(
    sessionId: string,
    requestedModelId: string,
    thinkingEffort?: string | null
  ): Promise<void> {
    const catalog = this.sessionCatalogs.get(sessionId);
    const cleanModel = requestedModelId.trim();
    if (
      cleanModel &&
      cleanModel !== "default" &&
      cleanModel !== "inherit" &&
      cleanModel !== "inherent"
    ) {
      await this.tryConfigureSessionModel(sessionId, cleanModel, {
        availableModels: catalog?.availableModels,
        configOptions: catalog?.configOptions,
        thinkingEffort,
      });
    }

    const cleanEffort = (thinkingEffort ?? "").trim();
    if (cleanEffort) {
      const effortOpt = catalog?.configOptions?.find(
        (c) =>
          c.id === "thought_level" ||
          c.id === "reasoning_effort" ||
          c.category === "thought_level"
      );
      if (effortOpt) {
        const cfgParams: AcpSessionSetConfigOptionParams = {
          sessionId,
          configId: effortOpt.id,
          value: cleanEffort,
        };
        await this.sendRequest("session/set_config_option", cfgParams, 10_000).catch(
          () => {}
        );
      }
    }
  }

  private async tryConfigureSessionModel(
    sessionId: string,
    requestedModelId: string,
    catalog?: {
      availableModels?: AcpSessionModelInfo[];
      configOptions?: AcpSessionConfigOption[];
      thinkingEffort?: string | null;
    }
  ): Promise<void> {
    const resolved = resolveBestAcpModelId(requestedModelId, catalog);
    const setModelTarget = resolved.setModelId;
    if (setModelTarget) {
      try {
        const setModelParams: AcpSessionSetModelParams = {
          sessionId,
          modelId: setModelTarget,
        };
        await this.sendRequest("session/set_model", setModelParams, 10_000);
        return;
      } catch {
        // Fallback to session/set_config_option below
      }
    }

    if (resolved.configOptionId && resolved.configValue) {
      const cfgParams: AcpSessionSetConfigOptionParams = {
        sessionId,
        configId: resolved.configOptionId,
        value: resolved.configValue,
      };
      await this.sendRequest("session/set_config_option", cfgParams, 10_000).catch(
        () => {}
      );
    }
  }

  async promptTurn(
    sessionId: string,
    promptText: string,
    opts?: { turnTimeoutMs?: number }
  ): Promise<{ stopReason: AcpStopReason }> {
    const stateCompletionPromise = new Promise<AcpStopReason>((resolve) => {
      const list = this.stateWaiters.get(sessionId) ?? [];
      list.push(resolve);
      this.stateWaiters.set(sessionId, list);
    });

    const params: AcpSessionPromptParams = {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    };

    const res = (await this.sendRequest(
      "session/prompt",
      params,
      opts?.turnTimeoutMs
    )) as AcpSessionPromptResult | null;

    if (res && typeof res.stopReason === "string" && res.stopReason.length > 0) {
      this.stateWaiters.delete(sessionId);
      return { stopReason: res.stopReason };
    }

    if (
      this.negotiatedProtocolVersion >= 2 ||
      res?.accepted === true ||
      res?.state === "working"
    ) {
      const stopReason = await stateCompletionPromise;
      return { stopReason };
    }

    this.stateWaiters.delete(sessionId);
    return { stopReason: "end_turn" };
  }

  cancelSession(sessionId: string): void {
    if (this.closed || !sessionId) return;
    for (const [id, entry] of this.pendingPermissions.entries()) {
      if (entry.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
        entry.cancel();
      }
    }
    const params: AcpSessionCancelParams = { sessionId };
    this.writeFrame({
      jsonrpc: "2.0",
      method: "session/cancel",
      params,
    });
  }

  async close(graceMs = 500): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      this.child?.stdin?.end();
    } catch {
      // ignore broken pipe
    }

    const pid = this.child?.pid ?? 0;
    if (pid > 0) {
      killProcessTree(pid);
    }

    this.rejectAllPending(new Error("ACP client closed"));

    if (this.exitPromise) {
      await Promise.race([
        this.exitPromise,
        new Promise<number>((r) => {
          const t = setTimeout(() => r(0), graceMs);
          t.unref?.();
        }),
      ]);
    }
  }

  sendRequest(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    if (this.closed || !this.child?.stdin) {
      return Promise.reject(new Error(`Cannot send '${method}': ACP client is closed`));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }

      this.pending.set(id, { method, resolve, reject, timer });
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  private writeFrame(frame: unknown): void {
    if (!this.child?.stdin || this.closed) return;
    const raw = JSON.stringify(frame);
    this.opts.onRawFrame?.("out", raw);
    try {
      this.child.stdin.write(`${raw}\n`, "utf8");
    } catch {
      // broken pipe handled on close
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nlIdx = this.stdoutBuffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = this.stdoutBuffer.slice(0, nlIdx).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
      if (line.trim()) {
        this.handleLine(line.trim());
      }
      nlIdx = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    this.opts.onRawFrame?.("in", line);
    if (!line.startsWith("{")) return;

    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const hasId =
      Object.prototype.hasOwnProperty.call(msg, "id") &&
      msg.id !== null &&
      msg.id !== undefined;
    const hasMethod = typeof msg.method === "string";

    if (hasId && !hasMethod) {
      const id = msg.id as JsonRpcId;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);

      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { code?: number; message?: string };
        const err = new Error(
          `ACP RPC error (${errObj.code ?? "unknown"}): ${errObj.message ?? "Unknown error"}`
        );
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (hasId && hasMethod) {
      const id = msg.id as JsonRpcId;
      const method = msg.method as string;
      if (method === "session/request_permission") {
        const params = (msg.params ?? {}) as AcpRequestPermissionParams;
        const onPermReq = this.opts.onPermissionRequest;
        if (onPermReq) {
          const cwd = this.opts.cwd ?? process.cwd();
          const safety = checkInteractivePermissionSafety(params, cwd);
          if (!safety.safe) {
            const deniedResult = selectPermissionOption(params.options ?? [], false);
            this.opts.onEvent?.({
              category: "permission",
              sessionId: params.sessionId ?? "",
              toolCallId: params.toolCall?.toolCallId,
              toolName:
                params.toolCall?.title ?? params.toolCall?.kind ?? "permission",
              permissionDecision: "denied",
              permissionReason: safety.reason,
              timestamp: Date.now(),
            });
            this.writeFrame({
              jsonrpc: "2.0",
              id,
              result: deniedResult,
            });
            return;
          }

          void this.handleInteractivePermission(id, params, onPermReq);
          return;
        }

        const evalRes = evaluateAcpPermissionRequest(params, this.opts.policyContext);
        this.opts.onEvent?.({
          category: "permission",
          sessionId: params.sessionId ?? "",
          toolCallId: params.toolCall?.toolCallId,
          toolName: params.toolCall?.title ?? params.toolCall?.kind ?? "permission",
          permissionDecision: evalRes.allowed ? "allowed" : "denied",
          permissionReason: evalRes.reason,
          timestamp: Date.now(),
        });
        this.writeFrame({
          jsonrpc: "2.0",
          id,
          result: evalRes.result,
        });
        return;
      }

      this.writeFrame({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not supported by ASD headless client: ${method}`,
        },
      });
      return;
    }

    if (!hasId && hasMethod) {
      const method = msg.method as string;
      if (method === "session/update") {
        const params = (msg.params ?? {}) as AcpSessionUpdateParams;
        const ev = normalizeAcpSessionUpdate(params);
        if (ev) {
          this.opts.onEvent?.(ev);
          if (ev.category === "state" && ev.sessionId) {
            const waiters = this.stateWaiters.get(ev.sessionId);
            if (waiters && waiters.length > 0) {
              this.stateWaiters.delete(ev.sessionId);
              for (const resolve of waiters) {
                resolve(ev.stopReason ?? "end_turn");
              }
            }
          }
        }
      }
    }
  }

  private async handleInteractivePermission(
    id: JsonRpcId,
    params: AcpRequestPermissionParams,
    onPermissionRequest: (
      params: AcpRequestPermissionParams
    ) => Promise<AcpRequestPermissionResult>
  ): Promise<void> {
    const sessionId = params.sessionId ?? "";
    let settled = false;

    const finalize = (rawResult: AcpRequestPermissionResult): void => {
      if (settled) return;
      settled = true;
      this.pendingPermissions.delete(id);

      const result: AcpRequestPermissionResult =
        rawResult &&
        typeof rawResult === "object" &&
        rawResult.outcome &&
        typeof rawResult.outcome === "object"
          ? rawResult
          : { outcome: { outcome: "cancelled" } };

      let allowed = false;
      if (result.outcome.outcome === "selected") {
        const selectedOptId = result.outcome.optionId;
        const opt = (params.options ?? []).find(
          (o) => o.optionId === selectedOptId
        );
        const isRejectOption = opt
          ? /^reject/i.test(opt.kind ?? "") || /^reject/i.test(opt.optionId)
          : /^reject/i.test(selectedOptId);
        allowed = !isRejectOption;
      }

      this.opts.onEvent?.({
        category: "permission",
        sessionId,
        toolCallId: params.toolCall?.toolCallId,
        toolName: params.toolCall?.title ?? params.toolCall?.kind ?? "permission",
        permissionDecision: allowed ? "allowed" : "denied",
        timestamp: Date.now(),
      });

      if (!this.closed) {
        this.writeFrame({
          jsonrpc: "2.0",
          id,
          result,
        });
      }
    };

    const cancelPromise = new Promise<AcpRequestPermissionResult>((resolve) => {
      this.pendingPermissions.set(id, {
        sessionId,
        cancel: () => {
          const cancelled: AcpRequestPermissionResult = {
            outcome: { outcome: "cancelled" },
          };
          finalize(cancelled);
          resolve(cancelled);
        },
      });
    });

    let reqPromise: Promise<AcpRequestPermissionResult>;
    try {
      reqPromise = Promise.resolve(onPermissionRequest(params)).catch(
        (): AcpRequestPermissionResult => ({
          outcome: { outcome: "cancelled" },
        })
      );
    } catch {
      reqPromise = Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const result = await Promise.race([reqPromise, cancelPromise]);
    finalize(result);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending.entries()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const [id, entry] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(id);
      entry.cancel();
    }
    for (const [, waiters] of this.stateWaiters.entries()) {
      for (const resolve of waiters) {
        resolve("cancelled");
      }
    }
    this.stateWaiters.clear();
  }
}

// ============================================================================
// 5. High-Level Subagent ACP Turn Runner (`executeAcpSubagentTurn`)
// ============================================================================

export interface ExecuteAcpSubagentTurnOptions {
  harness: HarnessId;
  role: AgentRole;
  model?: string | null;
  thinkingEffort?: string | null;
  prompt: string;
  cwd: string;
  allowedFiles: string[];
  metaPath?: string;
  logPath: string;
  resumeSessionId?: string | null;
  commandOverride?: { command: string; args: string[] };
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  allowSlidingTimeout?: boolean;
  onSpawn?: (pid: number) => void;
  onSessionIdDetected?: (sessionId: string) => void;
  onEvent?: (event: AcpNormalizedEvent) => void;
}

const DEFAULT_MAX_WALL_CEILING_MS = 4 * 60 * 60_000;

function formatEventForLog(ev: AcpNormalizedEvent): string {
  switch (ev.category) {
    case "text":
      return ev.text ?? "";
    case "thinking":
      return `\n[thinking] ${ev.thinking ?? ""}\n`;
    case "tool_use":
      return `\n[tool_use:${ev.toolName ?? "tool"}] ${ev.toolInput ?? ""}\n`;
    case "tool_result":
      return `\n[tool_result:${ev.toolName ?? "tool"}${ev.isError ? ":ERROR" : ""}] ${ev.toolOutput ?? ""}\n`;
    case "permission":
      return `\n[acp_permission:${ev.permissionDecision}] ${ev.toolName ?? ""}${ev.permissionReason ? ` (${ev.permissionReason})` : ""}\n`;
    case "state":
      return "";
  }
}

export async function executeAcpSubagentTurn(
  options: ExecuteAcpSubagentTurnOptions
): Promise<AcpTurnExecutionResult> {
  const startedAt = Date.now();
  const logStream = fs.createWriteStream(options.logPath, { flags: "a" });
  logStream.on("error", () => {});

  const writeRedactedLog = (raw: string): void => {
    if (!raw) return;
    logStream.write(redactSecrets(raw));
  };

  const readiness = options.commandOverride
    ? {
        supported: true,
        command: options.commandOverride.command,
        args: options.commandOverride.args,
      }
    : probeAcpCapability(options.harness, options.env ?? process.env);

  if (!readiness.supported) {
    const msg = `[ACP_UNAVAILABLE] ACP server not available for harness '${options.harness}'\n`;
    writeRedactedLog(msg);
    await new Promise<void>((r) => logStream.end(() => r()));
    return {
      exitCode: -1,
      pid: -1,
      sessionId: null,
      protocolVersion: 1,
      stopReason: null,
      assistantText: "",
      timedOut: false,
      status: "failed",
      durationMs: Date.now() - startedAt,
      errorSummary: msg,
    };
  }

  let sessionId: string | null = options.resumeSessionId ?? null;
  let assistantText = "";
  let timedOut = false;
  let timeoutReason: "idle" | "wall_clock" | undefined;
  let aborted = false;

  const baseWallMs = options.timeoutMs ?? options.maxDurationMs;
  const maxCeilingMs = options.maxDurationMs ?? DEFAULT_MAX_WALL_CEILING_MS;
  const slidingEnabled = options.allowSlidingTimeout ?? true;

  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelAbortResolver: (() => void) | null = null;

  const triggerAbort = (reason?: "idle" | "wall_clock"): void => {
    if (aborted) return;
    aborted = true;
    if (reason) {
      timedOut = true;
      timeoutReason = reason;
      const tag = reason === "idle" ? "IDLE_TIMEOUT" : "TIMEOUT";
      writeRedactedLog(`\n[${tag}] ACP turn timed out (${reason})\n`);
    }
    if (sessionId) {
      client.cancelSession(sessionId);
    }
    cancelAbortResolver?.();
  };

  const resetIdleWatchdog = (): void => {
    if (options.idleTimeoutMs === undefined || aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => triggerAbort("idle"), options.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const slideWallWatchdog = (): void => {
    if (baseWallMs === undefined || aborted) return;
    const elapsed = Date.now() - startedAt;
    const remainingCeiling = maxCeilingMs - elapsed;
    if (remainingCeiling <= 0) {
      triggerAbort("wall_clock");
      return;
    }
    const nextWindow = Math.min(baseWallMs, remainingCeiling);
    if (wallTimer) clearTimeout(wallTimer);
    wallTimer = setTimeout(() => triggerAbort("wall_clock"), nextWindow);
    wallTimer.unref?.();
  };

  const client = new AcpStdioClient({
    command: readiness.command,
    args: readiness.args,
    cwd: options.cwd,
    env: options.env,
    policyContext: {
      harness: options.harness,
      role: options.role,
      cwd: options.cwd,
      allowedFiles: options.allowedFiles,
      metaPath: options.metaPath,
      env: options.env,
    },
    onSpawn: options.onSpawn,
    onRawFrame: (dir, line) => {
      if (dir === "stderr") {
        resetIdleWatchdog();
        writeRedactedLog(line);
      }
    },
    onEvent: (ev) => {
      resetIdleWatchdog();
      if (slidingEnabled) {
        slideWallWatchdog();
      }
      if (ev.category === "text" && ev.text) {
        assistantText += ev.text;
      }
      writeRedactedLog(formatEventForLog(ev));
      options.onEvent?.(ev);
    },
  });

  const onExternalAbort = (): void => triggerAbort();
  if (options.signal) {
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal.aborted) triggerAbort();
  }

  if (baseWallMs !== undefined) {
    wallTimer = setTimeout(() => triggerAbort("wall_clock"), baseWallMs);
    wallTimer.unref?.();
  }
  resetIdleWatchdog();

  const abortRacePromise = new Promise<never>((_, reject) => {
    cancelAbortResolver = () => reject(new Error("ACP_TURN_ABORTED"));
    if (aborted) reject(new Error("ACP_TURN_ABORTED"));
  });

  let stopReason: AcpStopReason | null = null;
  let errorSummary: string | undefined;
  let exitCode = 0;
  let finalPid = 0;

  try {
    await Promise.race([client.connect(), abortRacePromise]);
    const sess = await Promise.race([
      client.startOrLoadSession({
        cwd: options.cwd,
        resumeSessionId: options.resumeSessionId,
        model: options.model,
        thinkingEffort: options.thinkingEffort,
      }),
      abortRacePromise,
    ]);
    sessionId = sess.sessionId;
    options.onSessionIdDetected?.(sessionId);

    const turnRes = await Promise.race([
      client.promptTurn(sessionId, options.prompt),
      abortRacePromise,
    ]);
    stopReason = turnRes.stopReason;

    if (stopReason === "cancelled" || stopReason === "refusal") {
      exitCode = 1;
      errorSummary = `ACP turn ended with stopReason='${stopReason}'`;
    }
  } catch (err) {
    exitCode = -1;
    if (!timedOut) {
      errorSummary = err instanceof Error ? err.message : String(err);
      writeRedactedLog(`\n[ACP_ERROR] ${errorSummary}\n`);
    } else {
      errorSummary =
        timeoutReason === "idle"
          ? `ACP subagent idle timeout (${options.idleTimeoutMs}ms)`
          : `ACP subagent wall-clock timeout`;
    }
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onExternalAbort);
    }
    if (aborted && sessionId) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 150);
        t.unref?.();
      });
    }
    finalPid = client.pid;
    await client.close(500);
    await new Promise<void>((r) => logStream.end(() => r()));
  }

  const durationMs = Date.now() - startedAt;
  return {
    exitCode: aborted ? -1 : exitCode,
    pid: finalPid,
    sessionId,
    protocolVersion: client.protocolVersion,
    stopReason,
    assistantText,
    timedOut,
    ...(timeoutReason ? { timeoutReason } : {}),
    status: !aborted && exitCode === 0 ? "done" : "failed",
    durationMs,
    ...(errorSummary ? { errorSummary } : {}),
  };
}
