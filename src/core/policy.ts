/**
 * ASD v2.3 Security Policy Engine (src/core/policy.ts)
 *
 * Implements:
 * 1. Ancestor-safe path resolution (`resolveSafeTargetPath`) using
 *    resolveExistingAncestorRealpath and normalizePathForCompare from config.ts
 *    to prevent jailbreaks and symlink traversal even when intermediate directories do not exist.
 * 2. Case-normalized protected path checks (.git/, .asd/, .env, *.pem, *.key, id_rsa).
 * 3. PreToolUse Hook guard (`evaluatePreToolUse`):
 *    - <1ms zero-DB read of ASD_SUBAGENT_META (meta.json).
 *    - Fail-closed if ASD_SESSION_ROLE === "subagent" and meta.json missing/unreadable.
 *    - Manifest-based write tool extraction and bash destructive/redirection inspection.
 * 4. Stop Hook guard (`evaluateStopHook`):
 *    - Subagent Shield: immediate allow without touching DB when subagent.
 *    - Main session 3-strike circuit breaker against no_progress_count in SQLite.
 * 5. Post-execution changed files boundary verification (`verifyChangedFilesBoundary`).
 *
 * Must NOT import anything from src/adapters/*.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadRoutingConfig,
  normalizePathForCompare,
  resolveAsdPaths,
} from "./config.ts";
import { SqliteDriver } from "./db.ts";
import {
  normalizeAntigravityModel,
  resolveLightSubagentModel,
} from "./router.ts";
import { ASD_VERSION, type SubagentSessionMeta } from "./types.ts";

export const POLICY_DENY_PREFIX =
  "[ASD Policy Guard — DO NOT bypass via shell/python/powershell]" as const;

export function formatPolicyDenyReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.startsWith("[ASD Policy Guard")) {
    return trimmed;
  }
  return `${POLICY_DENY_PREFIX} ${trimmed}`;
}

// ============================================================================
// Manifest & Policy Types
// ============================================================================

export interface HarnessToolConfig {
  WriteTools: string[];
  BashTools: string[];
  FilePathKeys: string[];
}

export interface HarnessToolManifest {
  _asdVersion?: string;
  harnesses: Record<string, HarnessToolConfig>;
}

export const DEFAULT_HARNESS_TOOL_MANIFEST: HarnessToolManifest = {
  _asdVersion: ASD_VERSION,
  harnesses: {
    "claude-code": {
      WriteTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      BashTools: ["Bash"],
      FilePathKeys: [
        "tool_input.file_path",
        "tool_input.notebook_path",
        "file_path",
        "path",
      ],
    },
    opencode: {
      WriteTools: ["write", "edit", "patch", "multiedit"],
      BashTools: ["bash"],
      FilePathKeys: ["filePath", "file_path", "path", "target"],
    },
    codex: {
      WriteTools: ["apply_patch", "write_file", "edit_file"],
      BashTools: ["shell", "exec_command", "bash"],
      FilePathKeys: ["path", "file_path", "target_file"],
    },
    antigravity: {
      WriteTools: [
        "write_file",
        "edit_file",
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
      ],
      BashTools: ["run_command"],
      FilePathKeys: [
        "Path",
        "TargetFile",
        "path",
        "file_path",
        "tool_input.Path",
        "tool_input.TargetFile",
      ],
    },
    cursor: {
      WriteTools: [
        "Write",
        "Edit",
        "StrReplace",
        "MultiEdit",
        "write_file",
        "edit_file",
        "apply_patch",
        "Delete",
      ],
      BashTools: ["Shell", "Bash", "run_terminal_cmd", "shell"],
      FilePathKeys: [
        "tool_input.file_path",
        "tool_input.path",
        "file_path",
        "path",
        "target_file",
        "filePath",
      ],
    },
  },
};

export interface SafePathResult {
  safe: boolean;
  resolvedPath: string;
  normalizedPath?: string;
  relativeToRoot?: string;
  reason?: string;
}

export interface ProtectedPathCheckResult {
  protected: boolean;
  reason?: string;
}

export interface PreToolUsePayload {
  harness?: string;
  toolName?: string;
  tool_name?: string;
  tool?: string;
  name?: string;
  tool_input?: Record<string, unknown>;
  input?: Record<string, unknown>;
  projectRoot?: string;
  [key: string]: unknown;
}

export interface PreToolUseResult {
  allowed: boolean;
  reason?: string;
  overwrite?: Record<string, unknown>;
}

export interface StopHookPayload {
  sessionId?: string;
  projectRoot?: string;
  roleType?: string;
  [key: string]: unknown;
}

export interface StopHookResult {
  decision: "allow" | "block";
  circuitBreakerTripped?: boolean;
  reason?: string;
}

export interface ChangedFilesBoundaryResult {
  valid: boolean;
  violations: string[];
}

// ============================================================================
// 1. Ancestor-Safe Path Resolution
// ============================================================================

/**
 * Resolves targetPath relative to rootDir, checking that the canonical normalized path
 * stays strictly inside rootDir even if intermediate directories do not exist yet.
 * Uses resolveExistingAncestorRealpath and normalizePathForCompare from config.ts.
 */
export function resolveSafeTargetPath(
  targetPath: string,
  rootDir: string
): SafePathResult {
  if (!targetPath || typeof targetPath !== "string") {
    return {
      safe: false,
      resolvedPath: "",
      reason: "Target path must be a non-empty string",
    };
  }

  if (targetPath.includes("\0")) {
    return {
      safe: false,
      resolvedPath: targetPath,
      reason: "Target path contains null byte",
    };
  }

  // Reject UNC paths (//server/share or \\server\share) and Windows device namespaces (\\?\, \\.\)
  // These bypass normal path resolution and can escape sandbox boundaries
  const uncOrDevicePrefix = /^(\\\\|\\\\?\\|\\\\\.\\|\/\/)/;
  if (uncOrDevicePrefix.test(targetPath)) {
    return {
      safe: false,
      resolvedPath: targetPath,
      reason: "UNC or device namespace paths are not allowed",
    };
  }

  // Determine absolute target path
  const absTarget = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(rootDir, targetPath);

  // Normalize target and root for comparison (walks up existing ancestors with realpathSync.native)
  const normTarget = normalizePathForCompare(absTarget);
  const normRoot = normalizePathForCompare(rootDir);

  // If normalization returned the 8.3 sentinel, fail-closed
  if (normTarget.includes("\0UNRESOLVABLE_8DOT3\0")) {
    return {
      safe: false,
      resolvedPath: absTarget,
      reason: "Path contains 8.3 short-name segment (e.g., PROGRA~1) — unresolvable",
    };
  }

  // Root prefix: ensure trailing slash to avoid matching sibling dirs with common prefixes
  const rootPrefix = normRoot.endsWith("/") ? normRoot : normRoot + "/";

  const isInside = normTarget === normRoot || normTarget.startsWith(rootPrefix);
  if (!isInside) {
    return {
      safe: false,
      resolvedPath: absTarget,
      normalizedPath: normTarget,
      reason: `Target path '${targetPath}' escapes root directory (${rootDir})`,
    };
  }

  return {
    safe: true,
    resolvedPath: absTarget,
    normalizedPath: normTarget,
    relativeToRoot: path.relative(rootDir, absTarget).replaceAll("\\", "/"),
  };
}

// ============================================================================
// 2. Protected Path & Secret File Checks
// ============================================================================

/**
 * Checks whether a relative path targets protected directories (.git/, .asd/)
 * or secret files (.env, *.pem, *.key, id_rsa). Case-normalized.
 */
export function checkProtectedPath(relPath: string): ProtectedPathCheckResult {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0) {
    return { protected: false };
  }

  // 1. Any segment named .git
  if (segments.some((seg) => seg === ".git")) {
    return {
      protected: true,
      reason: `Protected path: target '${relPath}' is inside protected .git directory`,
    };
  }

  // 2. Any segment named .asd
  if (segments.some((seg) => seg === ".asd")) {
    return {
      protected: true,
      reason: `Protected path: target '${relPath}' is inside protected .asd directory`,
    };
  }

  const basename = (segments[segments.length - 1] ?? "").toLowerCase();

  // 3. .env or .env.*
  if (basename === ".env" || basename.startsWith(".env.")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected .env file`,
    };
  }

  // 4. *.pem
  if (basename.endsWith(".pem")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected PEM certificate/key`,
    };
  }

  // 5. *.key
  if (basename.endsWith(".key")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected private key`,
    };
  }

  // 6. id_rsa, id_rsa.*, id_ed25519*, id_ecdsa*, id_dsa*
  if (
    basename === "id_rsa" ||
    basename.startsWith("id_rsa.") ||
    basename === "id_ed25519" ||
    basename.startsWith("id_ed25519.") ||
    basename === "id_ecdsa" ||
    basename.startsWith("id_ecdsa.") ||
    basename === "id_dsa" ||
    basename.startsWith("id_dsa.")
  ) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected SSH key`,
    };
  }

  // 7. *.pfx, *.p12 (PKCS#12 private key/certificate bundles)
  if (basename.endsWith(".pfx") || basename.endsWith(".p12")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected PKCS#12 key bundle`,
    };
  }

  // 8. Credential rc & OAuth secret files (.npmrc, .netrc, credentials.json)
  if (
    basename === ".npmrc" ||
    basename === ".netrc" ||
    basename === "credentials.json"
  ) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected credential configuration file`,
    };
  }

  return { protected: false };
}

// ============================================================================
// 3. Glob & Prefix Matcher for allowedFiles
// ============================================================================

/**
 * Lexically resolves . and .. segments in a POSIX-style path without touching the filesystem.
 * Returns the normalized path with all . and .. segments resolved.
 * Does not resolve symlinks or verify existence - purely lexical.
 */
function resolveLexicalPath(posixPath: string): string {
  const segments = posixPath.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (resolved.length > 0) {
        resolved.pop();
      }
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join("/");
}

/**
 * Matches target relative path against a glob or prefix pattern.
 * Case-normalized. Supports directory prefixes ("src/"), exact files, and globs ("*", "**").
 * Resolves lexical . and .. segments in target before matching to prevent traversal faking.
 */
export function matchGlobOrPrefix(
  targetRelPath: string,
  pattern: string
): boolean {
  // Normalize and lexically resolve target path to prevent traversal faking (P2)
  const target = resolveLexicalPath(
    targetRelPath
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .toLowerCase()
  );

  const pat = pattern
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();

  if (pat === "" || pat === "*" || pat === "**") {
    return true;
  }

  // Exact match
  if (target === pat) {
    return true;
  }

  // Directory prefix match: if pat ends with /
  if (pat.endsWith("/")) {
    return target.startsWith(pat);
  }

  // If pat has no wildcards, it may match directory without trailing slash
  if (!pat.includes("*") && !pat.includes("?")) {
    return target.startsWith(pat + "/");
  }

  // Glob matching via Node built-in path.posix.matchesGlob
  try {
    return path.posix.matchesGlob(target, pat);
  } catch {
    return false;
  }
}

export function isPathAllowed(
  relPath: string,
  allowedFiles: string[]
): boolean {
  if (!allowedFiles || allowedFiles.length === 0) {
    return false;
  }
  return allowedFiles.some((pat) => matchGlobOrPrefix(relPath, pat));
}

// ============================================================================
// 4. PreToolUse Hook Evaluator (1ms zero-DB guard)
// ============================================================================

function getNestedValue(
  obj: Record<string, unknown>,
  pathStr: string
): unknown {
  const parts = pathStr.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function extractFilePaths(
  payload: PreToolUsePayload,
  filePathKeys: string[]
): string[] {
  const paths: string[] = [];
  const input = (payload.tool_input ?? payload.input ?? {}) as Record<
    string,
    unknown
  >;

  for (const key of filePathKeys) {
    const valFromPayload = getNestedValue(
      payload as Record<string, unknown>,
      key
    );
    if (typeof valFromPayload === "string" && valFromPayload.trim() !== "") {
      paths.push(valFromPayload.trim());
    } else if (Array.isArray(valFromPayload)) {
      for (const item of valFromPayload) {
        if (typeof item === "string" && item.trim() !== "") {
          paths.push(item.trim());
        }
      }
    }

    if (!key.includes(".")) {
      const valFromInput = getNestedValue(input, key);
      if (typeof valFromInput === "string" && valFromInput.trim() !== "") {
        paths.push(valFromInput.trim());
      } else if (Array.isArray(valFromInput)) {
        for (const item of valFromInput) {
          if (typeof item === "string" && item.trim() !== "") {
            paths.push(item.trim());
          }
        }
      }
    }
  }

  return Array.from(new Set(paths));
}

function extractBashCommand(payload: PreToolUsePayload): string {
  const input = (payload.tool_input ?? payload.input ?? payload) as Record<
    string,
    unknown
  >;
  const candidates = [
    input.command,
    input.cmd,
    input.CommandLine,
    input.commandLine,
    input.script,
    payload.command,
    payload.cmd,
    payload.CommandLine,
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return "";
}

function stripBenignGitExclusions(cmd: string): string {
  return cmd
    // Exclude flags in grep/rg/find/fd/tar/git
    .replace(/--exclude-dir\s*=\s*['"]?[^'"\s]*\.git[^'"\s]*['"]?/gi, " ")
    .replace(/--exclude\s*=\s*['"]?[^'"\s]*\.git[^'"\s]*['"]?/gi, " ")
    .replace(/(?:-g|--glob)\s*=?[\s'"]*![^'"\s]*\.git[^'"\s]*['"]?/gi, " ")
    .replace(/-not\s+-path\s+['"][^'"]*\.git[^'"]*['"]/gi, " ")
    .replace(/!\s+-path\s+['"][^'"]*\.git[^'"]*['"]/gi, " ")
    // Remote git repository URLs (https://.../repo.git, git@github.com:.../repo.git)
    .replace(/(?:https?|git|ssh):\/\/[^\s'"]+\.git\b/gi, " ")
    .replace(/\bgit@[^\s'"]+\.git\b/gi, " ");
}

function hasInlineRuntimeFileWrite(s: string): boolean {
  if (
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|cpSync|copyFileSync|copyFile|unlinkSync|rmSync|rmdirSync|renameSync|createWriteStream)\s*\(/i.test(
      s
    )
  ) {
    return true;
  }
  if (/\[(?:system\.)?io\.file\]\s*::\s*(?:writeall|appendall|copy|delete|move|create)/i.test(s)) {
    return true;
  }
  if (
    /\b(?:python|python3|py)\b[\s\S]*?(?:\bopen\s*\([^)]*,\s*['"][wa+x]|\.write_(?:text|bytes)\s*\(|\bshutil\.(?:copy|copy2|copyfile|move|rmtree)\b|\bos\.(?:remove|unlink|rename|replace)\b)/i.test(
      s
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Detects shell redirection operators (>, >>, >&, process substitution >(...))
 * and PowerShell/inline-runtime write commands while respecting quoted strings
 * to avoid false positives like grep ">" file.
 */
function hasShellRedirection(cmd: string): boolean {
  // Check for >> (append) - simple and rarely appears in quotes legitimately
  if (cmd.includes(">>")) {
    return true;
  }

  // Check for process substitution >(...)
  if (/>\s*\(/.test(cmd)) {
    return true;
  }

  // Check for PowerShell write/create/copy/rename commands (case-insensitive, word boundaries)
  if (/\b(?:set-content|add-content|out-file|tee-object|new-item|copy-item|rename-item)\b/i.test(cmd)) {
    return true;
  }

  // Check for sed -i (in-place edit)
  if (/\bsed\s+-i\b/i.test(cmd)) {
    return true;
  }

  // Check for inline Node.js / Python / .NET file write calls
  if (hasInlineRuntimeFileWrite(cmd)) {
    return true;
  }

  // Detect shell command invocations that pass quoted scripts (cmd /c, powershell -c, bash -c, sh -c)
  // In these cases, redirection INSIDE the quoted string IS executed by the shell
  const shellInvocationMatch = cmd.match(/\b(?:cmd|powershell|pwsh|bash|sh)\s+(?:\/c|-c|-command)\s+(['"`])([\s\S]*?)\1/i);
  if (shellInvocationMatch) {
    const quotedScript = shellInvocationMatch[2];
    // Check for redirection inside the quoted script (quote-aware not needed here - the whole string is the script)
    if (quotedScript && hasRedirectionInScript(quotedScript)) {
      return true;
    }
  }

  // Quote-aware detection for > (single redirect) excluding 2>&1 and >&2
  // Track quote state to ignore > inside single/double quotes
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let prevChar = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? "";
    const nextChar = cmd[i + 1] ?? "";

    // Handle quote toggling (ignore escaped quotes)
    if (ch === "'" && prevChar !== "\\") {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && prevChar !== "\\") {
      inDoubleQuote = !inDoubleQuote;
    }

    // Check for > redirection when not inside quotes
    if (ch === ">" && !inSingleQuote && !inDoubleQuote) {
      // Exclude 2>&1, >&2, >&1, etc.
      if (nextChar === "&") {
        prevChar = ch;
        continue;
      }
      // Exclude 2> (file descriptor redirect) - check if preceded by digit
      if (prevChar.match(/^\d$/)) {
        prevChar = ch;
        continue;
      }
      // This is a genuine output redirection
      return true;
    }

    prevChar = ch;
  }

  return false;
}

/**
 * Checks for redirection operators in a script string (no quote tracking needed -
 * the entire string is treated as shell code where redirections are active).
 */
function hasRedirectionInScript(script: string): boolean {
  if (script.includes(">>")) return true;
  if (/>\(/.test(script)) return true; // process substitution
  if (/\b(?:set-content|add-content|out-file|tee-object|new-item|copy-item|rename-item)\b/i.test(script)) return true;
  if (/\bsed\s+-i\b/i.test(script)) return true;
  if (hasInlineRuntimeFileWrite(script)) return true;
  // Simple > detection (excluding 2>&1, >&2, 2>)
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let prevChar = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i] ?? "";
    const nextChar = script[i + 1] ?? "";
    if (ch === "'" && prevChar !== "\\") inSingleQuote = !inSingleQuote;
    else if (ch === '"' && prevChar !== "\\") inDoubleQuote = !inDoubleQuote;
    if (ch === ">" && !inSingleQuote && !inDoubleQuote) {
      if (nextChar === "&") { prevChar = ch; continue; }
      if (prevChar.match(/^\d$/)) { prevChar = ch; continue; }
      return true;
    }
    prevChar = ch;
  }
  return false;
}

function stripBenignAsdExclusions(cmd: string): string {
  return cmd
    .replace(/--exclude-dir\s*=\s*['"]?[^'"\s]*\.asd[^'"\s]*['"]?/gi, " ")
    .replace(/--exclude\s*=\s*['"]?[^'"\s]*\.asd[^'"\s]*['"]?/gi, " ")
    .replace(/(?:-g|--glob)\s*=?[\s'"]*![^'"\s]*\.asd[^'"\s]*['"]?/gi, " ")
    .replace(/-not\s+-path\s+['"][^'"]*\.asd[^'"]*['"]/gi, " ")
    .replace(/!\s+-path\s+['"][^'"]*\.asd[^'"]*['"]/gi, " ");
}

function isOfficialAsdOrCommitMetadataSegment(seg: string): boolean {
  const trimmed = seg.trim();
  if (/^\bgit\s+commit\b/i.test(trimmed)) return true;
  if (
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:asd\b|(?:node|bun|tsx)\b[^\n;|&]*?(?:src[/\\]cli[/\\]index\.(?:ts|js)|bin[/\\]asd))\s+(?:plan|dispatch|verify|debate|status|clean|logs|sync|doctor|resume|update|ui|dashboard|uninstall|hook|mcp|handoff|migrate)\b/i.test(
      trimmed
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Detects AI / sub-harness commit attribution (`Co-authored-by:`, `--author=`,
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` overrides, or AI commit footers) inside
 * `git commit`, `git merge`, or `git cherry-pick` shell segments so sub-harnesses
 * (such as Claude Code or OpenCode / Oh-My-OpenAgent `sisyphus-dev-ai`) cannot
 * pollute repository contributor lists.
 */
export function hasAiCommitAttribution(cmd: string): boolean {
  if (!cmd || !/\bgit\b/i.test(cmd)) return false;

  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    const isGitCommitOrMerge =
      /(?:^|\s)git(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:commit|merge|cherry-pick)\b/i.test(
        trimmed
      );
    if (!isGitCommitOrMerge) continue;

    // 1. Any Co-authored-by trailer injected into git commit / merge message
    if (/co-authored-by\s*:/i.test(trimmed)) {
      return true;
    }

    // 2. --author override or GIT_AUTHOR / GIT_COMMITTER env vars pointing to AI bots
    if (
      /--author(?:\s+|=)['"]?[^'"]*?(?:sisyphus|claude|anthropic|opencode|openagent|cursor|copilot|codex|gemini|asd\s*agent|asd@local)/i.test(
        trimmed
      ) ||
      /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)\s*=\s*['"]?[^'"\s]*?(?:sisyphus|claude|anthropic|opencode|openagent|cursor|copilot|codex|gemini|asd)/i.test(
        trimmed
      )
    ) {
      return true;
    }

    // 3. Standard AI commit footers (Claude Code / Oh-My-OpenAgent Sisyphus)
    if (
      /generated\s+with\s+\[?claude(?:\s+code)?\]?/i.test(trimmed) ||
      /ultraworked\s+with\s+\[?sisyphus\]?/i.test(trimmed)
    ) {
      return true;
    }
  }

  return false;
}

function isBlockedMainAsdCommand(cmd: string): boolean {
  const sanitized = stripBenignAsdExclusions(cmd);
  const lower = sanitized.toLowerCase();
  const unquoted = lower.replace(/['"`]/g, "");

  const hasAsdToken =
    lower.includes(".asd/") ||
    lower.includes(".asd\\") ||
    unquoted.includes(".asd/") ||
    unquoted.includes(".asd\\") ||
    /(?:^|[\s"'`=/\\])\.asd(?:[/\\]|[\s"'`]|$)/.test(lower) ||
    /(?:^|[\s=/\\])\.asd(?:[/\\]|\s|$)/.test(unquoted);

  if (!hasAsdToken) return false;

  // Always block shell output redirection targeting .asd
  if (
    /(?:>>|(?<![2&])>(?!&))\s*['"]?(?:[^\s'"]*[/\\])?\.asd(?:[/\\]|['"\s;|]|$)/i.test(
      sanitized
    ) ||
    /(?:>>|(?<![2&])>(?!&))\s*(?:[^\s;|]*[/\\])?\.asd(?:[/\\]|[\s;|]|$)/i.test(
      unquoted
    )
  ) {
    return true;
  }

  // Inspect individual shell segments so official `asd <cmd>` or `git commit -m`
  // with `.asd` in text metadata is allowed, while direct shell mutation/deletion/sqlite3 is denied.
  const segments = sanitized.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const seg of segments) {
    if (!seg.trim()) continue;
    const segLower = seg.toLowerCase();
    const segUnquoted = segLower.replace(/['"`]/g, "");
    const segHasAsd =
      segLower.includes(".asd/") ||
      segLower.includes(".asd\\") ||
      segUnquoted.includes(".asd/") ||
      segUnquoted.includes(".asd\\") ||
      /(?:^|[\s"'`=/\\])\.asd(?:[/\\]|[\s"'`]|$)/.test(segLower) ||
      /(?:^|[\s=/\\])\.asd(?:[/\\]|\s|$)/.test(segUnquoted);
    if (!segHasAsd) continue;
    if (isOfficialAsdOrCommitMetadataSegment(seg)) continue;

    if (
      /\b(?:rm|rmdir|del|erase|mv|move|cp|copy|ren|rename|chmod|chown|truncate|sqlite3|remove-item|move-item|copy-item|new-item|rename-item|set-content|add-content|out-file|tee-object|tee)\b/i.test(
        seg
      ) ||
      /\bsed\s+-i\b/i.test(seg) ||
      hasInlineRuntimeFileWrite(seg)
    ) {
      return true;
    }
  }

  return false;
}

function isBlockedMainEnvCommand(cmd: string): boolean {
  const envFileRegex =
    /(?:^|[\s"'`=:/\\])\.env(?:\.(?!example\b|sample\b|template\b)[a-z0-9._-]+)?(?:[\s"'`;|&><)]|$)/i;
  const lower = cmd.toLowerCase();
  const unquoted = lower.replace(/['"`]/g, "");
  if (!envFileRegex.test(lower) && !envFileRegex.test(unquoted)) {
    return false;
  }

  // Always block shell redirection targeting .env
  if (
    /(?:>>|(?<![2&])>(?!&))\s*['"]?(?:[^\s'"]*[/\\])?\.env(?:\.(?!example\b|sample\b|template\b)[a-z0-9._-]+)?(?:['"\s;|]|$)/i.test(
      cmd
    )
  ) {
    return true;
  }

  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const seg of segments) {
    if (!seg.trim()) continue;
    const segLower = seg.toLowerCase();
    const segUnquoted = segLower.replace(/['"`]/g, "");
    if (!envFileRegex.test(segLower) && !envFileRegex.test(segUnquoted)) continue;
    if (isOfficialAsdOrCommitMetadataSegment(seg)) continue;

    if (
      /\b(?:cat|type|get-content|gc|head|tail|more|less|source|rm|rmdir|del|erase|mv|move|cp|copy|ren|rename|remove-item|move-item|copy-item|new-item|rename-item|set-content|add-content|out-file|tee-object|tee|truncate)\b/i.test(
        seg
      ) ||
      /(?:^|\s)\.\s+['"]?[^\s'"]*\.env\b/i.test(seg) ||
      /\bnode\s+--env-file/i.test(seg) ||
      /\bsed\s+-i\b/i.test(seg) ||
      hasInlineRuntimeFileWrite(seg)
    ) {
      return true;
    }
  }

  return false;
}

function isBlockedGitCommand(cmd: string, isSubagent: boolean): boolean {
  const sanitized = stripBenignGitExclusions(cmd);
  const lower = sanitized.toLowerCase();
  const unquoted = lower.replace(/['"`]/g, "");

  // Check for GIT_DIR=<path> git ... form (P4)
  const gitDirMatch = lower.match(/(?:^|\s)git_dir\s*=\s*([^\s;|&]+)/);
  let gitDirNonProtected = false;
  if (gitDirMatch) {
    const gitDirPath = gitDirMatch[1];
    if (gitDirPath && isProtectedGitPath(gitDirPath)) {
      return true;
    }
    gitDirNonProtected = true;
  }

  // Check for git -C <path> ... form (P4)
  const gitCMatch = lower.match(/\bgit\s+-C\s+([^\s;|&]+)/);
  let gitCNonProtected = false;
  if (gitCMatch) {
    const gitCPath = gitCMatch[1];
    if (gitCPath && isProtectedGitPath(gitCPath)) {
      return true;
    }
    gitCNonProtected = true;
  }

  // For subagents: if the ONLY .git references are in non-protected GIT_DIR/-C forms, allow
  // Create a version of the command with non-protected GIT_DIR/-C forms masked out
  let checkLower = lower;
  let checkUnquoted = unquoted;
  if (gitDirNonProtected) {
    checkLower = checkLower.replace(/(?:^|\s)git_dir\s*=\s*[^\s;|&]+/gi, " ");
    checkUnquoted = checkUnquoted.replace(/(?:^|\s)git_dir\s*=\s*[^\s;|&]+/gi, " ");
  }
  if (gitCNonProtected) {
    checkLower = checkLower.replace(/\bgit\s+-C\s+[^\s;|&]+/gi, " ");
    checkUnquoted = checkUnquoted.replace(/\bgit\s+-C\s+[^\s;|&]+/gi, " ");
  }

  const hasGitPathToken =
    checkLower.includes(".git/") ||
    checkLower.includes(".git\\") ||
    checkUnquoted.includes(".git/") ||
    checkUnquoted.includes(".git\\") ||
    /(?:^|[\s"'`=/\\])\.git(?:[/\\]|[\s"'`]|$)/.test(checkLower) ||
    /(?:^|[\s=/\\])\.git(?:[/\\]|\s|$)/.test(checkUnquoted);

  if (!hasGitPathToken) {
    return false;
  }

  // Subagents are strictly forbidden from touching or inspecting .git paths via bash
  if (isSubagent) {
    return true;
  }

  // For the main session, avoid false positives when .git appears inside JSON payloads or commit messages,
  // while blocking any direct destructive/write/config manipulation targeting .git
  const hasDestructiveOrWriteOp =
    /\b(?:rm|rmdir|del|erase|mv|move|cp|copy|chmod|chown|remove-item|move-item|copy-item|set-content|add-content|out-file|tee|truncate)\b/i.test(
      sanitized
    ) ||
    /\bsed\s+-i\b/i.test(sanitized) ||
    /(?:>>|(?<![2&])>(?!&))\s*['"]?(?:[^\s'"]*[/\\])?\.git(?:[/\\]|['"\s]|$)/i.test(
      sanitized
    ) ||
    /(?:^|[\s"'`=/\\])\.git[/\\](?:config|hooks|head|index|objects|refs|logs|info|packed-refs)\b/i.test(
      lower
    ) ||
    /(?:^|[\s=/\\])\.git[/\\](?:config|hooks|head|index|objects|refs|logs|info|packed-refs)\b/i.test(
      unquoted
    );

  if (hasDestructiveOrWriteOp) {
    return true;
  }

  // Also block bare shell commands directly targeting .git as a standalone path argument (e.g. `rm -rf .git`, `ls .git`)
  // when not part of an `asd plan` / `git commit -m` payload
  if (
    !/\basd\b.*\bplan\b/i.test(sanitized) &&
    !/\bgit\s+commit\b/i.test(sanitized) &&
    /(?:^|[;&|]\s*)(?:rm|rmdir|del|erase|mv|move|ls|dir|cat|type|head|tail)\b[^\n;|]*?(?:^|[\s"'`/\\])\.git(?:[/\\]|[\s"'`]|$)/i.test(
      unquoted
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Determines if a path string targets a protected .git directory (repo metadata).
 * Protected paths are relative paths containing .git that don't escape the project root:
 * - .git, .git/, .git\...
 * - ./git, ./.git/, subdir/.git, etc.
 * Non-protected (allowed): absolute paths, paths starting with ../, URLs
 */
function isProtectedGitPath(pathStr: string): boolean {
  const p = pathStr.toLowerCase();
  // Absolute paths (Windows drive letter or POSIX root or UNC)
  if (/^[a-z]:[/\\]/i.test(p) || p.startsWith("/") || p.startsWith("\\\\")) {
    return false;
  }
  // Paths that escape upward (../)
  if (p.startsWith("..")) {
    return false;
  }
  // Remote URLs
  if (/^(?:https?|git|ssh):\/\//.test(p) || /^git@/.test(p)) {
    return false;
  }
  // Contains .git as a path segment (protected repo metadata)
  // Match .git at start of string or after path separator, followed by separator or end
  return /(^|[/\\])\.git(?:[/\\]|$)/.test(p);
}

/**
 * Evaluates PreToolUse hook requests in <1ms without opening SQLite.
 * Fail-closed if ASD_SESSION_ROLE === "subagent" and meta.json is missing or unreadable.
 */
export function evaluatePreToolUse(
  payload: PreToolUsePayload,
  manifest?: HarnessToolManifest,
  env?: Record<string, string | undefined>
): PreToolUseResult {
  const activeEnv = env ?? process.env;
  const isSubagent = activeEnv.ASD_SESSION_ROLE === "subagent";
  const manifestConfig = manifest ?? DEFAULT_HARNESS_TOOL_MANIFEST;

  // 1. Subagent fail-closed meta.json check
  let meta: SubagentSessionMeta | undefined;
  if (isSubagent) {
    const metaPath = activeEnv.ASD_SUBAGENT_META;
    if (!metaPath) {
      return {
        allowed: false,
        reason: formatPolicyDenyReason(
          "Fail-closed: ASD_SESSION_ROLE is subagent but ASD_SUBAGENT_META is not set"
        ),
      };
    }
    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      meta = JSON.parse(raw) as SubagentSessionMeta;
    } catch (err) {
      return {
        allowed: false,
        reason: formatPolicyDenyReason(
          `Fail-closed: failed to read subagent meta.json at ${metaPath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  } else if (activeEnv.ASD_SUBAGENT_META) {
    try {
      const raw = fs.readFileSync(activeEnv.ASD_SUBAGENT_META, "utf8");
      meta = JSON.parse(raw) as SubagentSessionMeta;
    } catch {
      // Ignore for non-subagent
    }
  }

  const toolName = (
    payload.toolName ??
    payload.tool_name ??
    payload.tool ??
    payload.name ??
    ""
  ).toString();

  const harnessId = (payload.harness ?? meta?.harness ?? "") as string;
  let harnessTools: HarnessToolConfig | undefined;
  if (harnessId && manifestConfig.harnesses[harnessId]) {
    harnessTools = manifestConfig.harnesses[harnessId];
  }

  const rootDir =
    meta?.worktreePath ??
    payload.projectRoot ??
    activeEnv.ASD_PROJECT_ROOT ??
    process.cwd();

  // 1b. Antigravity invoke_subagent Model tier enforcement (overwrite "inherit" or raw model strings)
  if (toolName.toLowerCase() === "invoke_subagent") {
    const inputObj = (payload.tool_input ??
      payload.input ??
      (payload.toolCall && typeof payload.toolCall === "object"
        ? (payload.toolCall as Record<string, unknown>).args
        : undefined) ??
      payload) as Record<string, unknown>;

    const rawModel =
      typeof inputObj.Model === "string"
        ? inputObj.Model.trim()
        : typeof inputObj.model === "string"
          ? inputObj.model.trim()
          : "";

    const rawTypeName =
      typeof inputObj.TypeName === "string"
        ? inputObj.TypeName.trim()
        : typeof inputObj.typeName === "string"
          ? inputObj.typeName.trim()
          : typeof inputObj.Role === "string"
            ? inputObj.Role.trim()
            : typeof inputObj.role === "string"
              ? inputObj.role.trim()
              : "";

    const isExplicitValidTier =
      rawModel === "flash_lite" || rawModel === "flash" || rawModel === "pro";

    if (!isExplicitValidTier) {
      let targetTier: string;
      const normalizedFromExplicit =
        rawModel && rawModel.toLowerCase() !== "inherit" && rawModel.toLowerCase() !== "inherent"
          ? normalizeAntigravityModel(rawModel)
          : "inherit";

      if (normalizedFromExplicit !== "inherit") {
        targetTier = normalizedFromExplicit;
      } else {
        let routingCfg;
        try {
          routingCfg = loadRoutingConfig(rootDir, activeEnv.ASD_HOME_DIR);
        } catch {
          routingCfg = undefined;
        }
        targetTier =
          resolveLightSubagentModel("antigravity", rawTypeName, routingCfg) ??
          "flash";
      }

      return {
        allowed: true,
        overwrite: {
          Model: targetTier,
        },
      };
    }

    return { allowed: true };
  }

  // 2. Check if tool is BashTool
  const isBashTool = harnessTools
    ? harnessTools.BashTools.some(
        (bt) => bt.toLowerCase() === toolName.toLowerCase()
      )
    : Object.values(manifestConfig.harnesses).some((h) =>
        h.BashTools.some((bt) => bt.toLowerCase() === toolName.toLowerCase())
      );

  if (isBashTool) {
    const cmd = extractBashCommand(payload);
    const cmdLower = cmd.toLowerCase();

    // Protect .git corruption for both host and subagent (with benign exclusions allowed)
    if (isBlockedGitCommand(cmd, isSubagent)) {
      return {
        allowed: false,
        reason: formatPolicyDenyReason(
          "Bash command blocked: targets protected .git directory"
        ),
      };
    }

    // Block AI / sub-harness Co-authored-by trailers and --author overrides on both host and subagent
    if (hasAiCommitAttribution(cmd)) {
      return {
        allowed: false,
        reason: formatPolicyDenyReason(
          "Bash command blocked: Co-authored-by trailers and AI --author / footer attribution in git commit/merge are forbidden. Re-run git commit without Co-authored-by, AI footers, or --author so commits remain attributed solely to the repository owner."
        ),
      };
    }

    if (isSubagent) {
      const cmdUnquoted = cmdLower.replace(/['"`]/g, "");
      if (
        cmdLower.includes(".asd/") ||
        cmdLower.includes(".asd\\") ||
        cmdUnquoted.includes(".asd/") ||
        cmdUnquoted.includes(".asd\\") ||
        /(?:^|[\s"'`/\\])\.asd(?:[/\\]|[\s"'`]|$)/.test(cmdLower) ||
        /(?:^|[\s/\\])\.asd(?:[/\\]|\s|$)/.test(cmdUnquoted)
      ) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            "Bash command blocked for subagent: targets protected .asd directory"
          ),
        };
      }
      const envFileRegex =
        /(?:^|[\s"'`=:/\\])\.env(?:\.(?!example\b|sample\b|template\b)[a-z0-9._-]+)?(?:[\s"'`;|&><)]|$)/i;
      if (envFileRegex.test(cmdLower) || envFileRegex.test(cmdUnquoted)) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            "Bash command blocked for subagent: targets protected .env file"
          ),
        };
      }
      // Block redirection writes: > or >> (excluding 2>&1 and >&2) and shell/script write bypasses
      // Quote-aware detection to avoid false positives like grep ">" file
      if (hasShellRedirection(cmd)) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            "Bash command blocked for subagent: output redirection (>, >>, Out-File, Set-Content, New-Item, Copy-Item, tee, inline script write, process substitution) is forbidden. DO NOT attempt to bypass allowedFiles via shell/bash commands; emit a crossScopeRequests entry in your final asd-report block instead."
          ),
        };
      }
      // Block destructive / boundary-escaping file commands and direct subagent git history mutations
      if (
        /\b(?:rm|rmdir|del|erase|mv|move|cp|copy|ren|rename|patch|remove-item|move-item|copy-item|rename-item)\b/i.test(
          cmd
        ) ||
        /\bgit(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:checkout|restore|apply|am|clean|reset|stash|commit|push|merge|rebase|cherry-pick|tag)\b/i.test(
          cmd
        )
      ) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            "Bash command blocked for subagent: destructive, file-mutating, or git-history-mutating shell command (rm, del, mv, cp, patch, git commit/push/merge/rebase/checkout/restore/apply, Remove-Item) is forbidden"
          ),
        };
      }
    } else {
      // Main session Bash guard: protect .asd/ from direct shell writes/deletions and protect .env files
      if (isBlockedMainAsdCommand(cmd)) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            "Bash command blocked: direct shell mutation/deletion of protected .asd directory is forbidden; use official 'asd' CLI commands instead"
          ),
        };
      }
      if (isBlockedMainEnvCommand(cmd)) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            "Bash command blocked: direct shell access/mutation of protected .env file is forbidden"
          ),
        };
      }
    }

    return { allowed: true };
  }

  // 3. Check if tool is WriteTool
  const isWriteTool = harnessTools
    ? harnessTools.WriteTools.some(
        (wt) => wt.toLowerCase() === toolName.toLowerCase()
      )
    : Object.values(manifestConfig.harnesses).some((h) =>
        h.WriteTools.some((wt) => wt.toLowerCase() === toolName.toLowerCase())
      );

  if (!isWriteTool) {
    return { allowed: true };
  }

  // 4. WriteTool: extract target file paths
  const filePathKeys = harnessTools
    ? harnessTools.FilePathKeys
    : Array.from(
        new Set(
          Object.values(manifestConfig.harnesses).flatMap(
            (h) => h.FilePathKeys
          )
        )
      );

  const targetPaths = extractFilePaths(payload, filePathKeys);
  if (targetPaths.length === 0) {
    return {
      allowed: false,
      reason: formatPolicyDenyReason(
        "Write tool detected but target file path could not be extracted"
      ),
    };
  }

  // 5. Verify each target path
  for (const targetPath of targetPaths) {
    if (targetPath.includes("\0")) {
      return {
        allowed: false,
        reason: formatPolicyDenyReason("Target path contains null byte"),
      };
    }

    const safeCheck = resolveSafeTargetPath(targetPath, rootDir);

    if (isSubagent) {
      // Subagents are strictly confined inside rootDir + allowedFiles
      if (!safeCheck.safe) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            `${
              safeCheck.reason ??
              `Target path '${targetPath}' escapes root directory`
            }. DO NOT attempt to bypass via shell/bash commands. Emit a crossScopeRequests entry in your final asd-report block instead.`
          ),
        };
      }

      const relPath = path
        .relative(rootDir, safeCheck.resolvedPath)
        .replaceAll("\\", "/");

      const protCheck = checkProtectedPath(relPath);
      if (protCheck.protected) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            protCheck.reason ?? `Target path '${relPath}' is a protected path`
          ),
        };
      }

      if (meta) {
        if (!meta.allowedFiles || meta.allowedFiles.length === 0) {
          return {
            allowed: false,
            reason: formatPolicyDenyReason(
              `Target path '${relPath}' is blocked: subagent allowedFiles is empty. DO NOT attempt to bypass via shell/bash commands. Emit a crossScopeRequests entry in your final asd-report block instead.`
            ),
          };
        }
        const allowed = isPathAllowed(relPath, meta.allowedFiles);
        if (!allowed) {
          return {
            allowed: false,
            reason: formatPolicyDenyReason(
              `Target path '${relPath}' is outside allowedFiles boundary. DO NOT attempt to bypass via shell/bash commands. Emit a crossScopeRequests entry in your final asd-report block instead.`
            ),
          };
        }
      }
    } else {
      // Main session (!isSubagent): allow external paths (e.g. ~/.gemini/**/brain/**, ~/.claude/memory/**, os.tmpdir())
      // so the main agent never resorts to Bash/PowerShell workarounds, while pin-point blocking protected paths anywhere.
      const pathToCheck = safeCheck.safe
        ? path.relative(rootDir, safeCheck.resolvedPath).replaceAll("\\", "/")
        : targetPath.replaceAll("\\", "/");

      const protCheck = checkProtectedPath(pathToCheck);
      if (protCheck.protected) {
        return {
          allowed: false,
          reason: formatPolicyDenyReason(
            protCheck.reason ?? `Target path '${targetPath}' is a protected path`
          ),
        };
      }
    }
  }

  return { allowed: true };
}

// ============================================================================
// 5. Stop Hook Evaluator (Subagent Shield & 3-strike breaker)
// ============================================================================

/**
 * Evaluates Stop hook requests.
 * - Subagent Shield: immediate allow when subagent without touching DB.
 * - Main session: blocks while pending/running tasks remain until no_progress_count >= 3.
 */
export function evaluateStopHook(
  payload: StopHookPayload,
  env?: Record<string, string | undefined>,
  db?: SqliteDriver
): StopHookResult {
  const activeEnv = env ?? process.env;

  // Subagent Shield: env check
  if (activeEnv.ASD_SESSION_ROLE === "subagent") {
    return { decision: "allow" };
  }

  // Subagent Shield: payload check
  if (payload.roleType === "subagent") {
    return { decision: "allow" };
  }

  // Subagent Shield: meta.json check without opening SQLite
  const metaPath = activeEnv.ASD_SUBAGENT_META;
  if (metaPath) {
    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      const meta = JSON.parse(raw);
      if (meta.roleType === "subagent") {
        return { decision: "allow" };
      }
    } catch {
      // Ignore read failure for stop hook
    }
  }

  // Main session: check SQLite sessions and tasks
  const sessionId =
    payload.sessionId ??
    activeEnv.ASD_MAIN_SESSION_ID ??
    activeEnv.ASD_SESSION_ID;

  if (!sessionId) {
    return { decision: "allow" };
  }

  let driver = db;
  let ownedDriver = false;

  if (!driver) {
    const projectRoot =
      payload.projectRoot ?? activeEnv.ASD_PROJECT_ROOT ?? process.cwd();
    const paths = resolveAsdPaths(projectRoot);
    if (!fs.existsSync(paths.dbPath)) {
      return { decision: "allow" };
    }
    // Scoped to projectRoot: the shared DB holds other projects' sessions too.
    driver = new SqliteDriver(paths.dbPath, projectRoot);
    ownedDriver = true;
  }

  try {
    const session =
      driver.getSession(sessionId) ??
      driver.listSessions().find((s) => s.harness_session_id === sessionId);
    if (!session) {
      return { decision: "allow", reason: `Session not found: ${sessionId}` };
    }

    if (session.phase === "done") {
      return { decision: "allow", reason: "Session phase is done" };
    }

    const tasks = driver.getSessionTasks(session.session_id);
    const unfinishedTasks = tasks.filter(
      (t) =>
        t.status === "pending" ||
        t.status === "running" ||
        t.status === "verifying"
    );

    if (unfinishedTasks.length === 0) {
      return { decision: "allow", reason: "All tasks are completed" };
    }

    // 3-strike circuit breaker
    if (session.no_progress_count >= 3) {
      return {
        decision: "allow",
        circuitBreakerTripped: true,
        reason: `Circuit breaker tripped after ${session.no_progress_count} no-progress attempts with ${unfinishedTasks.length} unfinished tasks`,
      };
    }

    driver.incrementNoProgress(session.session_id);
    const newCount = session.no_progress_count + 1;
    return {
      decision: "block",
      reason: `Unfinished tasks remain (${unfinishedTasks.length} pending/running). Attempt ${newCount}/3 before circuit breaker.`,
    };
  } finally {
    if (ownedDriver && driver) {
      driver.close();
    }
  }
}

// ============================================================================
// 6. Post-execution Changed Files Boundary Verification
// ============================================================================

/**
 * Post-execution verification helper used by asd_verify to inspect
 * changed files from git status against allowedFiles and protected paths.
 */
export function verifyChangedFilesBoundary(
  changedFiles: string[],
  allowedFiles: string[],
  rootDir: string
): ChangedFilesBoundaryResult {
  const violations: string[] = [];

  for (const file of changedFiles) {
    if (!file || file.trim() === "") continue;

    const safeCheck = resolveSafeTargetPath(file, rootDir);
    if (!safeCheck.safe) {
      violations.push(
        `File '${file}' escapes rootDir (${rootDir}): ${
          safeCheck.reason ?? "outside root"
        }`
      );
      continue;
    }

    const relPath = path
      .relative(rootDir, safeCheck.resolvedPath)
      .replaceAll("\\", "/");

    const protCheck = checkProtectedPath(relPath);
    if (protCheck.protected) {
      violations.push(
        `File '${file}' targets protected path: ${protCheck.reason}`
      );
      continue;
    }

    if (allowedFiles && allowedFiles.length > 0) {
      const allowed = isPathAllowed(relPath, allowedFiles);
      if (!allowed) {
        violations.push(
          `File '${file}' ('${relPath}') is outside allowedFiles boundary [${allowedFiles.join(
            ", "
          )}]`
        );
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
