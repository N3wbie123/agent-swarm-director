/**
 * ASD OpenCode Version Detection & Capability Profile (src/core/opencode-profile.ts)
 *
 * Detects the installed OpenCode CLI version (v1 vs v2) with optional env override
 * (`ASD_OPENCODE_PROFILE`), short-TTL caching, Windows-safe command probing, and
 * safe fallback to the V1 compatibility profile when detection fails.
 *
 * HC-1 Core Purity: imports ONLY node:* built-ins and ./types.ts.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  OpenCodeCapabilityProfile,
  OpenCodePluginApiVersion,
  OpenCodeVersionInfo,
} from "./types.ts";

export const DEFAULT_OPENCODE_PROBE_TIMEOUT_MS = 3000;
export const OPENCODE_VERSION_CACHE_TTL_MS = 30_000;

const DEFAULT_FALLBACK_WARNING =
  "OpenCode version could not be detected; falling back safely to V1 compatibility profile.";

export interface OpenCodeCommandRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type OpenCodeCommandRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => OpenCodeCommandRunnerResult;

export interface DetectOpenCodeVersionOptions {
  env?: Record<string, string | undefined>;
  commandRunner?: OpenCodeCommandRunner;
  timeoutMs?: number;
  bypassCache?: boolean;
}

interface CachedVersionEntry {
  expiresAt: number;
  value: OpenCodeVersionInfo;
}

const versionCache = new Map<string, CachedVersionEntry>();

// Matches strict semver tokens (MAJOR.MINOR.PATCH[-prerelease][+build]) with optional leading `v`,
// preventing IPv4 addresses or bare numeric fragments from matching.
const SEMVER_LINE_PATTERN =
  /(?:^|[\s:/=(@])v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[\s,;)\]])/;

const BARE_SEMVER_LINE_PATTERN =
  /^v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

// eslint-disable-next-line no-control-regex
const ANSI_CSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_CSI_PATTERN, "");
}

function classifyPluginApi(major: number | null): OpenCodePluginApiVersion {
  if (major === 1) return "v1";
  if (major !== null && major >= 2) return "v2";
  return "unknown";
}

function extractSemverMatch(
  line: string,
  pattern: RegExp
): { version: string; major: number } | null {
  const match = line.match(pattern);
  if (!match?.[1] || !match[2]) return null;
  const major = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(major) || major < 0) return null;
  return { version: match[1], major };
}

/**
 * Parses `opencode --version` output into a normalized semver, major version, and plugin API profile.
 */
export function parseOpenCodeVersionOutput(raw: string | null | undefined): {
  version: string | null;
  major: number | null;
  pluginApi: OpenCodePluginApiVersion;
} {
  if (typeof raw !== "string") {
    return { version: null, major: null, pluginApi: "unknown" };
  }

  const cleaned = stripAnsi(raw).replace(/\r\n/g, "\n").trim();
  if (!cleaned) {
    return { version: null, major: null, pluginApi: "unknown" };
  }

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // 1. Prefer lines explicitly referencing `opencode` (avoids matching unrelated runtime notices).
  for (const line of lines) {
    if (/opencode/i.test(line)) {
      const hit = extractSemverMatch(line, SEMVER_LINE_PATTERN);
      if (hit) {
        return {
          version: hit.version,
          major: hit.major,
          pluginApi: classifyPluginApi(hit.major),
        };
      }
    }
  }

  // 2. Next prefer standalone version lines (e.g. V1 bare semver `1.19.4` or `v2.0.0-beta.1+build.42`).
  for (const line of lines) {
    const hit = extractSemverMatch(line, BARE_SEMVER_LINE_PATTERN);
    if (hit) {
      return {
        version: hit.version,
        major: hit.major,
        pluginApi: classifyPluginApi(hit.major),
      };
    }
  }

  // 3. Fallback to first semver token across all lines.
  for (const line of lines) {
    const hit = extractSemverMatch(line, SEMVER_LINE_PATTERN);
    if (hit) {
      return {
        version: hit.version,
        major: hit.major,
        pluginApi: classifyPluginApi(hit.major),
      };
    }
  }

  return { version: null, major: null, pluginApi: "unknown" };
}

function getPathEnv(env: Record<string, string | undefined>): string {
  if (env.PATH !== undefined) return env.PATH;
  if (env.Path !== undefined) return env.Path;
  return "";
}

function resolveBinaryOnPath(
  binaryName: string,
  env: Record<string, string | undefined>
): string | null {
  const pathEnv = getPathEnv(env);
  if (!pathEnv) return null;

  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // Ignore filesystem permission errors while scanning PATH
      }
    }
  }

  return null;
}

function tryExtractNpmCmdScript(cmdFilePath: string): string | null {
  try {
    const shimContent = fs.readFileSync(cmdFilePath, "utf8");
    const shimDir = path.dirname(cmdFilePath);
    const match = shimContent.match(/"%(?:~)?dp0%\\([^"]+\.(?:c?m?js))"\s+%\*/i);
    if (match?.[1]) {
      const scriptPath = path.resolve(shimDir, match[1]);
      if (fs.existsSync(scriptPath)) {
        return scriptPath;
      }
    }
  } catch {
    // Fall back to cmd.exe execution
  }
  return null;
}

function createDefaultCommandRunner(
  env: Record<string, string | undefined>
): OpenCodeCommandRunner {
  return (cmd, args, timeoutMs) => {
    const resolved =
      path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/")
        ? fs.existsSync(cmd)
          ? cmd
          : null
        : resolveBinaryOnPath(cmd, env);

    const run = (execCmd: string, execArgs: string[]): OpenCodeCommandRunnerResult => {
      const res = child_process.spawnSync(execCmd, execArgs, {
        env: env as NodeJS.ProcessEnv,
        stdio: "pipe",
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
      });
      return {
        status: res.status,
        stdout: typeof res.stdout === "string" ? res.stdout : "",
        stderr: typeof res.stderr === "string" ? res.stderr : "",
        ...(res.error ? { error: res.error } : {}),
      };
    };

    if (process.platform === "win32") {
      if (resolved) {
        if (/\.exe$/i.test(resolved)) {
          return run(resolved, args);
        }
        if (/\.ps1$/i.test(resolved)) {
          const pwsh =
            resolveBinaryOnPath("pwsh", env) ??
            resolveBinaryOnPath("powershell", env) ??
            "powershell.exe";
          return run(pwsh, [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolved,
            ...args,
          ]);
        }
        if (/\.(cmd|bat)$/i.test(resolved)) {
          const scriptPath = tryExtractNpmCmdScript(resolved);
          if (scriptPath) {
            return run(process.execPath, [scriptPath, ...args]);
          }
          const comspec = env.ComSpec || process.env.ComSpec || "cmd.exe";
          return run(comspec, ["/d", "/c", resolved, ...args]);
        }
      }

      const direct = run(resolved ?? cmd, args);
      if (!direct.error) {
        return direct;
      }
      const comspec = env.ComSpec || process.env.ComSpec || "cmd.exe";
      return run(comspec, ["/d", "/c", cmd, ...args]);
    }

    return run(resolved ?? cmd, args);
  };
}

function buildFallbackWarning(reason: string): string {
  return `OpenCode version could not be detected (${reason}); falling back safely to V1 compatibility profile.`;
}

function buildCacheKey(env: Record<string, string | undefined>): string {
  const pathEnv = getPathEnv(env);
  const resolved = resolveBinaryOnPath("opencode", env) ?? "";
  return `${process.platform}\0${resolved}\0${pathEnv}`;
}

/**
 * Clears the cached OpenCode CLI version detection results.
 */
export function resetOpenCodeVersionCache(): void {
  versionCache.clear();
}

/**
 * Detects the active OpenCode version and plugin API profile via env override
 * (`ASD_OPENCODE_PROFILE`) or `opencode --version` probe, with safe V1 fallback.
 */
export function detectOpenCodeVersion(
  options?: DetectOpenCodeVersionOptions
): OpenCodeVersionInfo {
  const env = options?.env ?? process.env;
  const overrideRaw = env.ASD_OPENCODE_PROFILE?.trim().toLowerCase();
  if (overrideRaw === "v1" || overrideRaw === "v2") {
    return {
      rawOutput: null,
      version: null,
      major: overrideRaw === "v2" ? 2 : 1,
      pluginApi: overrideRaw,
      source: "env-override",
    };
  }

  const useCache = !options?.commandRunner && options?.bypassCache !== true;
  const cacheKey = !options?.commandRunner ? buildCacheKey(env) : "";
  if (useCache) {
    const cached = versionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value };
    }
  }

  const timeoutMs =
    typeof options?.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_OPENCODE_PROBE_TIMEOUT_MS;

  const runner = options?.commandRunner ?? createDefaultCommandRunner(env);

  let result: OpenCodeVersionInfo;
  try {
    const res = runner("opencode", ["--version"], timeoutMs);
    const stdout = typeof res.stdout === "string" ? res.stdout : "";
    const stderr = typeof res.stderr === "string" ? res.stderr : "";
    const combinedRaw = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || null;

    if (res.error) {
      result = {
        rawOutput: combinedRaw,
        version: null,
        major: null,
        pluginApi: "unknown",
        source: "fallback",
        degradedWarning: buildFallbackWarning(res.error.message || "CLI probe error"),
      };
    } else if (res.status !== 0) {
      const reason =
        res.status === null
          ? "CLI probe terminated without exit status (timeout or signal)"
          : `CLI exited with status ${res.status}`;
      result = {
        rawOutput: combinedRaw,
        version: null,
        major: null,
        pluginApi: "unknown",
        source: "fallback",
        degradedWarning: buildFallbackWarning(reason),
      };
    } else {
      const stdoutParsed = parseOpenCodeVersionOutput(stdout);
      const parsed =
        stdoutParsed.version !== null
          ? stdoutParsed
          : parseOpenCodeVersionOutput(stderr);
      const rawOutput = stdout.trim() || stderr.trim() || null;

      if (parsed.pluginApi === "v1" || parsed.pluginApi === "v2") {
        result = {
          rawOutput,
          version: parsed.version,
          major: parsed.major,
          pluginApi: parsed.pluginApi,
          source: "cli-probe",
        };
      } else {
        const reason = parsed.version
          ? `unsupported OpenCode version ${parsed.version}`
          : "unparseable --version output";
        result = {
          rawOutput,
          version: parsed.version,
          major: parsed.major,
          pluginApi: "unknown",
          source: "fallback",
          degradedWarning: buildFallbackWarning(reason),
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      rawOutput: null,
      version: null,
      major: null,
      pluginApi: "unknown",
      source: "fallback",
      degradedWarning: buildFallbackWarning(message || "unexpected CLI probe error"),
    };
  }

  if (!options?.commandRunner) {
    versionCache.set(cacheKey, {
      expiresAt: Date.now() + OPENCODE_VERSION_CACHE_TTL_MS,
      value: { ...result },
    });
  }

  return result;
}

/**
 * Maps detected OpenCode version metadata to concrete CLI/ACP/plugin/server capabilities.
 */
export function buildOpenCodeCapabilityProfile(
  versionInfo: OpenCodeVersionInfo
): OpenCodeCapabilityProfile {
  if (versionInfo.pluginApi === "v2") {
    return {
      version: versionInfo,
      pluginApi: "v2",
      effectiveProfile: "v2",
      degraded: false,
      supportsNativeBackground: true,
      supportsAcp: true,
      acpArgs: ["acp"],
      headlessRunFlags: ["--auto"],
      supportsModelsCmd: true,
      pluginDirName: "plugins",
      pluginRelativePath: "plugins/asd-guard/index.js",
      serverEventPath: "/api/event",
      serverAbortPathTemplate: "/api/session/{sessionId}/interrupt",
      usesV1SessionCallback: false,
    };
  }

  const degraded = versionInfo.pluginApi === "unknown";
  const warning = degraded
    ? versionInfo.degradedWarning || DEFAULT_FALLBACK_WARNING
    : versionInfo.degradedWarning;

  return {
    version: versionInfo,
    pluginApi: versionInfo.pluginApi,
    effectiveProfile: "v1",
    degraded,
    ...(warning ? { warning } : {}),
    supportsNativeBackground: false,
    supportsAcp: true,
    acpArgs: ["acp", "--pure"],
    headlessRunFlags: ["--pure"],
    supportsModelsCmd: true,
    pluginDirName: "plugin",
    pluginRelativePath: "plugin/asd-guard.js",
    serverEventPath: "/event",
    serverAbortPathTemplate: "/session/{sessionId}/abort",
    usesV1SessionCallback: true,
  };
}

/**
 * Convenience helper combining OpenCode version detection and capability profile construction.
 */
export function resolveOpenCodeCapabilityProfile(
  options?: DetectOpenCodeVersionOptions
): OpenCodeCapabilityProfile {
  return buildOpenCodeCapabilityProfile(detectOpenCodeVersion(options));
}
