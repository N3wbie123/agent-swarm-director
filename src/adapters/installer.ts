/**
 * ASD v2.7.0 Harness Installer & Control Plane Synchronizer (src/adapters/installer.ts)
 *
 * Implements:
 * 1. Strictly Global-Only `syncHarnessConfigs` / `runAsdSync`:
 *    - Installs harness-targeted skills, agents, hooks, and external catalog MCP configurations
 *      into global user homes (~/.claude, ~/.config/opencode, ~/.codex, ~/.gemini, ~/.cursor).
 *    - Never touches or pollutes project directories during sync.
 *    - Idempotent: checks composite SHA-256 hash against last-sync.json and file existence;
 *      skips unneeded writes with { skipped: true } indicators.
 *    - Injects SessionStart, PreToolUse, and Stop CLI hooks pointing to dynamic
 *      <ASD_ROOT>/src/cli/index.ts (CLI-only; ASD's legacy MCP server is retired).
 * 2. Main-Session Auto-Sync (`autoSyncIfNeeded`):
 *    - Guarded by Subagent Shield (ASD_SESSION_ROLE !== "subagent").
 * 3. Surgical `uninstallHarnessConfigs` / `runAsdUninstall`:
 *    - Rollback restoring original configs 100% cleanly without touching user settings.
 *    - Removes _asdManaged hooks, removes TOML fences, removes ASD agents and skills.
 * 4. Fast zero-token `doctorProbe` / `runAsdDoctor`:
 *    - <100ms probe checking Node >=22.13.0, SQLite WAL mode, Git repo state,
 *      harness CLI availability, and synthetic PreToolUse block probe (.GIT/config, .ENV).
 */

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import { checkForRemoteUpdate, compareSemver, resolveHomeDir } from "../core/config.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { CLAUDE_ACP_INSTALL_HINT, CODEX_ACP_INSTALL_HINT } from "../core/acp-client.ts";
import { parseJsonc, removeTomlFence, upsertTomlFence } from "../core/jsonc.ts";
import {
  discoverHarnessModels,
  inspectOrRemapRoutingModels,
  writeModelsDiskCache,
  type HarnessModelCatalog,
  type RoutingModelRemap,
  type RoutingModelWarning,
} from "../core/models.ts";
import { evaluatePreToolUse } from "../core/policy.ts";
import { resolveLightSubagentRoute } from "../core/router.ts";
import {
  AGENT_ROLES,
  ASD_VERSION,
  registerCoreInstallerHooks,
  type AcpHarnessReadiness,
  type HarnessAdapter,
  type HarnessId,
  type RoutingConfig,
} from "../core/types.ts";
import { antigravityAdapter } from "./antigravity.ts";
import {
  ASD_SKILLS,
  claudeCodeAdapter,
  isAsdManagedClaudeHook,
  mergeClaudeSettings,
} from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import {
  generateOpencodeGuardPlugin,
  opencodeAdapter,
} from "./opencode.ts";
import {
  cleanupLegacyAgentFiles,
  generateAgentContent,
  generateAllAgentsMarkdown,
  getAgentTemplate,
  resolveHarnessRoleModel,
  type GenerateAgentContentOptions,
} from "./installer/agent-renderer.ts";
import {
  bootstrapGlobalMcpPreset,
  buildCodexManagedTomlBlock,
  loadCatalogMcpServers,
  loadHarnessNativeCapabilities,
  mergeJsonMcpServersForHarness,
  stripAsdManagedMcpEntries,
  syncJsonMcpConfigFile,
  type CatalogMcpEntry,
} from "./installer/mcp-sync.ts";
import {
  getSkillTemplate,
  renderSkillTemplate,
  resolveHarnessConditionalBlocks,
  substituteLightModelPlaceholders,
  type RenderSkillOptions,
} from "./installer/skill-renderer.ts";

// Backward-compatible Facade re-exports
export {
  getSkillTemplate,
  renderSkillTemplate,
  resolveHarnessConditionalBlocks,
  substituteLightModelPlaceholders,
  type RenderSkillOptions,
  resolveHarnessRoleModel,
  getAgentTemplate,
  generateAgentContent,
  generateAllAgentsMarkdown,
  type GenerateAgentContentOptions,
  loadHarnessNativeCapabilities,
  loadCatalogMcpServers,
  mergeJsonMcpServersForHarness,
  syncJsonMcpConfigFile,
  buildCodexManagedTomlBlock,
  type CatalogMcpEntry,
};

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface SyncHarnessOptions {
  homeDir?: string;
  force?: boolean;
  projectRoot?: string;
  asdCliPath?: string;
  noPath?: boolean;
  discoverModels?: boolean;
  refreshModels?: boolean;
  skipModelDiscovery?: boolean;
  modelCatalogOverride?: HarnessModelCatalog;
  env?: Record<string, string | undefined>;
}

export interface HarnessSyncStatus {
  harness: HarnessId;
  status: "updated" | "skipped";
  skipped: boolean;
  filesWritten: string[];
}

export interface SyncHarnessConfigsResult {
  status: "updated" | "skipped";
  skipped: boolean;
  configHash: string;
  harnesses: Record<HarnessId, HarnessSyncStatus>;
  cliShimsInstalled?: string[];
  modelsBootstrapped?: RoutingModelRemap[];
  modelsRemapped?: RoutingModelRemap[];
  modelWarnings?: RoutingModelWarning[];
  acpReadiness?: Record<HarnessId, AcpHarnessReadiness>;
  acpBridgeHints?: string[];
}

export interface UninstallHarnessOptions {
  homeDir?: string;
}

export interface UninstallHarnessStatus {
  removed: string[];
  restored: string[];
}

export interface UninstallHarnessConfigsResult {
  status: "success";
  removedFiles: string[];
  restoredFiles: string[];
  harnesses: Record<HarnessId, UninstallHarnessStatus>;
}

export interface DoctorProbeOptions {
  homeDir?: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message?: string;
}

export interface DoctorProbeResult {
  ok: boolean;
  durationMs: number;
  checks: DoctorCheck[];
  nodeVersion: { ok: boolean; version: string; minRequired: string };
  sqliteWal: { ok: boolean; message?: string };
  gitRepo: { ok: boolean; isRepo: boolean; message?: string };
  harnesses: Record<
    HarnessId,
    {
      installed: boolean;
      headlessSupported: boolean;
      binary?: string;
      resolvedPath?: string | null;
      hookCoverage?: {
        preToolUse: "native-hook" | "plugin-hook" | "sandbox-only";
        stop: "native-hook" | "plugin-hook";
      };
      acp?: AcpHarnessReadiness;
    }
  >;
  acpBridgeHints?: string[];
  policyProbe: { ok: boolean; gitBlocked: boolean; envBlocked: boolean; message?: string };
  errors: string[];
}

export interface AutoSyncOptions {
  homeDir?: string;
  projectRoot?: string;
  force?: boolean;
  skipModelDiscovery?: boolean;
}

export interface AutoSyncResult {
  synced: boolean;
  skipped: boolean;
  reason?: string;
  result?: SyncHarnessConfigsResult;
}

interface LastSyncRecord {
  _asdVersion: string;
  configHash: string;
  lastSyncedAt: string;
  harnesses: Partial<Record<HarnessId, { hash: string; syncedAt: string; userConfigHashes?: Record<string, string> }>>;
}

// ============================================================================
// Constants & Helper Functions
// ============================================================================

const DEFAULT_HARNESS_IDS: readonly HarnessId[] = [
  "claude-code",
  "opencode",
  "codex",
  "antigravity",
  "cursor",
];

function getAsdRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function resolveMultipleBinariesOnPath(
  binaryNames: readonly string[],
  env: Record<string, string | undefined> = process.env
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const name of binaryNames) {
    result[name] = null;
  }

  const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  const caseInsensitive = process.platform === "win32";
  let remaining = binaryNames.length;

  for (const dir of dirs) {
    if (remaining <= 0) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const fileMap = new Map<string, string>();
    for (const entry of entries) {
      if (entry.isFile() || entry.isSymbolicLink()) {
        const key = caseInsensitive ? entry.name.toLowerCase() : entry.name;
        if (!fileMap.has(key)) {
          fileMap.set(key, entry.name);
        }
      }
    }
    for (const bin of binaryNames) {
      if (result[bin] !== null) continue;
      for (const ext of extensions) {
        const candidate = `${bin}${ext}`;
        const key = caseInsensitive ? candidate.toLowerCase() : candidate;
        const actualName = fileMap.get(key);
        if (actualName) {
          result[bin] = path.join(dir, actualName);
          remaining--;
          break;
        }
      }
    }
  }

  return result;
}

function probeAllHarnessesAcp(
  env: Record<string, string | undefined> = process.env
): {
  acpReadiness: Record<HarnessId, AcpHarnessReadiness>;
  acpBridgeHints: string[];
  installedClis: Record<HarnessId, { binary: string; resolvedPath: string | null }>;
} {
  const bins = resolveMultipleBinariesOnPath(
    [
      "claude",
      "opencode",
      "codex",
      "agy",
      "cursor-agent",
      "agent",
      "claude-agent-acp",
      "claude-code-acp",
      "codex-acp",
    ],
    env
  );

  const claudePath = bins["claude"] ?? null;
  const opencodePath = bins["opencode"] ?? null;
  const codexPath = bins["codex"] ?? null;
  const agyPath = bins["agy"] ?? null;
  const cursorAgentPath = bins["cursor-agent"] ?? null;
  const agentPath = bins["agent"] ?? null;
  const cursorBin = cursorAgentPath ? "cursor-agent" : "agent";
  const cursorPath = cursorAgentPath ?? agentPath;

  const installedClis: Record<HarnessId, { binary: string; resolvedPath: string | null }> = {
    "claude-code": { binary: "claude", resolvedPath: claudePath },
    opencode: { binary: "opencode", resolvedPath: opencodePath },
    codex: { binary: "codex", resolvedPath: codexPath },
    antigravity: { binary: "agy", resolvedPath: agyPath },
    cursor: { binary: cursorBin, resolvedPath: cursorPath },
  };

  const claudeBridgePrimary = bins["claude-agent-acp"] ?? null;
  const claudeBridgeLegacy = bins["claude-code-acp"] ?? null;
  const codexBridge = bins["codex-acp"] ?? null;

  const acpReadiness: Record<HarnessId, AcpHarnessReadiness> = {
    "claude-code": claudeBridgePrimary
      ? {
          harness: "claude-code",
          supported: true,
          mode: "bridge",
          command: "claude-agent-acp",
          args: [],
          resolvedPath: claudeBridgePrimary,
        }
      : claudeBridgeLegacy
        ? {
            harness: "claude-code",
            supported: true,
            mode: "bridge",
            command: "claude-code-acp",
            args: [],
            resolvedPath: claudeBridgeLegacy,
          }
        : {
            harness: "claude-code",
            supported: false,
            mode: "missing-bridge",
            command: "claude-agent-acp",
            args: [],
            resolvedPath: null,
            installHint: CLAUDE_ACP_INSTALL_HINT,
          },
    opencode: {
      harness: "opencode",
      supported: Boolean(opencodePath),
      mode: "native",
      command: "opencode",
      args: ["acp", "--pure"],
      resolvedPath: opencodePath,
    },
    codex: codexBridge
      ? {
          harness: "codex",
          supported: true,
          mode: "bridge",
          command: "codex-acp",
          args: [],
          resolvedPath: codexBridge,
        }
      : {
          harness: "codex",
          supported: false,
          mode: "missing-bridge",
          command: "codex-acp",
          args: [],
          resolvedPath: null,
          installHint: CODEX_ACP_INSTALL_HINT,
        },
    antigravity: {
      harness: "antigravity",
      supported: Boolean(agyPath),
      mode: "native",
      command: "agy",
      args: ["acp", "--dangerously-skip-permissions"],
      resolvedPath: agyPath,
    },
    cursor: {
      harness: "cursor",
      supported: Boolean(cursorPath),
      mode: "native",
      command: cursorBin,
      args: ["acp"],
      resolvedPath: cursorPath,
    },
  };

  const acpBridgeHints: string[] = [];
  const missingBridgePackages: string[] = [];
  if (claudePath && !acpReadiness["claude-code"].supported) {
    missingBridgePackages.push("@agentclientprotocol/claude-agent-acp");
    acpBridgeHints.push(
      `claude-code: ACP bridge not found (streaming CLI fallback remains active). Optional setup: ${CLAUDE_ACP_INSTALL_HINT}`
    );
  }
  if (codexPath && !acpReadiness.codex.supported) {
    missingBridgePackages.push("@agentclientprotocol/codex-acp");
    acpBridgeHints.push(
      `codex: ACP bridge not found (streaming CLI fallback remains active). Optional setup: ${CODEX_ACP_INSTALL_HINT}`
    );
  }
  if (missingBridgePackages.length === 2) {
    acpBridgeHints.push(
      `Install both ACP bridges at once: npm i -g ${missingBridgePackages.join(" ")}`
    );
  }

  return { acpReadiness, acpBridgeHints, installedClis };
}

export interface AntigravityHookSpec {
  cliArg: string;
  launcherSource: string | null;
}

/**
 * Build Antigravity hooks.json CLI argument & optional space-free launcher script.
 *
 * On Windows, Antigravity executes hooks via Go's `exec.Command("cmd", "/c", command)`
 * with `cwd` set to `~/.gemini/config/`. Go's `syscall.EscapeArg` escapes `"` into `\"`,
 * causing `node.exe`'s MSVC C runtime to parse `\"` as a literal `"` character in `argv[1]`.
 * Therefore Windows hook commands MUST NOT embed `"` around the script path:
 * - Space-free paths: pass unquoted forward-slash path directly (`C:/.../src/cli/index.ts`).
 * - Paths with spaces on Windows: emit a space-free `./asd-hook.mjs` launcher next to `hooks.json`
 *   that imports `main` via `file://` URL (percent-encoding spaces), and invoke `./asd-hook.mjs`.
 * - Paths with spaces on POSIX (`sh -c`): wrap in double quotes (`"${escapedPosix}"`).
 */
export function buildAntigravityHookSpec(
  asdCliPath: string,
  platform: NodeJS.Platform = process.platform
): AntigravityHookSpec {
  const posixCliPath = asdCliPath.replaceAll("\\", "/");
  if (!/\s/.test(posixCliPath)) {
    return { cliArg: posixCliPath, launcherSource: null };
  }
  if (platform === "win32") {
    const fileUrl = pathToFileURL(path.resolve(asdCliPath)).href;
    const launcherSource = [
      "// Auto-generated by ASD sync for Windows CLI paths containing spaces.",
      "// Avoids Go exec.Command(\"cmd\", \"/c\", ...) quote-escaping into literal \\\" in node argv[1].",
      `import { main } from ${JSON.stringify(fileUrl)};`,
      "const code = await main();",
      "if (code !== 0) process.exit(code);",
      "",
    ].join("\n");
    return { cliArg: "./asd-hook.mjs", launcherSource };
  }
  const escapedPosix = posixCliPath.replace(/(["\\$`])/g, "\\$1");
  return { cliArg: `"${escapedPosix}"`, launcherSource: null };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function safeWriteText(filePath: string, text: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, "utf8");
}

function backupUserFile(filePath: string, asdManagedContent?: string): void {
  const backupPath = `${filePath}.asd-backup`;
  if (!fs.existsSync(filePath)) {
    return;
  }
  const liveContent = fs.readFileSync(filePath, "utf8");
  // If live content equals ASD-managed output, do NOT touch the backup (never let backup hold ASD content)
  if (asdManagedContent !== undefined && liveContent === asdManagedContent) {
    return;
  }
  // If backup doesn't exist, create it
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    return;
  }
  // Backup exists: refresh it ONLY if live differs from BOTH backup AND ASD-managed output
  const backupContent = fs.readFileSync(backupPath, "utf8");
  if (liveContent !== backupContent && (asdManagedContent === undefined || liveContent !== asdManagedContent)) {
    fs.copyFileSync(filePath, backupPath);
  }
}

function restoreUserBackup(filePath: string): boolean {
  const backupPath = `${filePath}.asd-backup`;
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Ignore unlink errors
    }
    return true;
  }
  return false;
}

function hasAsdManagedMarkers(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // Check for common ASD-managed markers across config formats
    if (content.includes("_asdManaged")) return true;
    if (content.includes("BEGIN MANAGED BY ASD-V2")) return true;
    if (content.includes("# >>> BEGIN MANAGED BY ASD-V2")) return true;
    if (content.includes('"_asdVersion"')) return true;
    return false;
  } catch {
    return false;
  }
}

function smartRestoreUserBackup(filePath: string): "restored" | "kept-live" | "no-backup" {
  const backupPath = `${filePath}.asd-backup`;
  if (!fs.existsSync(backupPath)) {
    return "no-backup";
  }
  if (!fs.existsSync(filePath)) {
    // Live file gone, restore from backup
    fs.copyFileSync(backupPath, filePath);
    try { fs.unlinkSync(backupPath); } catch {}
    return "restored";
  }
  const liveContent = fs.readFileSync(filePath, "utf8");
  const backupContent = fs.readFileSync(backupPath, "utf8");
  if (liveContent === backupContent) {
    // Live matches backup, nothing to do
    try { fs.unlinkSync(backupPath); } catch {}
    return "restored";
  }
  // Live differs from backup: if live has no ASD markers, keep live (user edited post-sync)
  if (!hasAsdManagedMarkers(filePath)) {
    try { fs.unlinkSync(backupPath); } catch {}
    return "kept-live";
  }
  // Live has ASD markers but differs from backup: restore backup (ASD content was modified)
  fs.copyFileSync(backupPath, filePath);
  try { fs.unlinkSync(backupPath); } catch {}
  return "restored";
}

function computeUserConfigHashes(homeDir: string, harnessId: HarnessId): Record<string, string> {
  const hashes: Record<string, string> = {};
  const adapter = {
    "claude-code": claudeCodeAdapter,
    opencode: opencodeAdapter,
    codex: codexAdapter,
    antigravity: antigravityAdapter,
    cursor: cursorAdapter,
  }[harnessId];
  if (!adapter) return hashes;
  const targets = adapter.globalConfigTargets(homeDir);
  for (const targetPath of targets) {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, "utf8");
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
      hashes[targetPath] = hash;
    }
  }
  return hashes;
}

// Skill & Agent Markdown Generation extracted to:
//   - ./installer/skill-renderer.ts
//   - ./installer/agent-renderer.ts

// ============================================================================
// Preset Bootstrapping & Hash Calculation
// ============================================================================

const LEGACY_ANTIGRAVITY_CLI_MODEL_MAP: Record<string, string> = {
  "gemini-3-flash-lite": "gemini-3.8-flash-low",
  "gemini-3.5-flash-lite": "gemini-3.8-flash-low",
  "gemini-3-flash": "gemini-3.8-flash-medium",
  "gemini-3.8-flash": "gemini-3.8-flash-medium",
  "gemini-3-pro": "gemini-4-carbon-high",
  "gemini-3.1-pro": "gemini-4-carbon-high",
  "gemini-3.1-pro-high": "gemini-4-carbon-high",
};

function migrateAntigravityRouteGroup(group: unknown): boolean {
  if (!group || typeof group !== "object") return false;
  let changed = false;
  for (const route of Object.values(group as Record<string, unknown>)) {
    if (!route || typeof route !== "object") continue;
    const entry = route as Record<string, unknown>;
    if (entry.harness === "antigravity" && typeof entry.model === "string") {
      const replacement = LEGACY_ANTIGRAVITY_CLI_MODEL_MAP[entry.model];
      if (replacement) {
        entry.model = replacement;
        changed = true;
      }
    }
    if (Array.isArray(entry.fallbacks)) {
      for (const fb of entry.fallbacks) {
        if (!fb || typeof fb !== "object") continue;
        const fbRec = fb as Record<string, unknown>;
        if (fbRec.harness === "antigravity" && typeof fbRec.model === "string") {
          const replacement = LEGACY_ANTIGRAVITY_CLI_MODEL_MAP[fbRec.model];
          if (replacement) {
            fbRec.model = replacement;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

function migrateLegacyAntigravityCliModels(routing: Record<string, unknown>): boolean {
  let changed = false;
  if (migrateAntigravityRouteGroup(routing.agents)) changed = true;
  if (migrateAntigravityRouteGroup(routing.categories)) changed = true;
  if (routing.heavyRouting && typeof routing.heavyRouting === "object") {
    const heavy = routing.heavyRouting as Record<string, unknown>;
    if (migrateAntigravityRouteGroup(heavy.agents)) changed = true;
    if (migrateAntigravityRouteGroup(heavy.categories)) changed = true;
  }
  return changed;
}

function formatGlobalRoutingHeader(): string {
  return [
    `// ASD v${ASD_VERSION} global user model routing configuration (~/.asd/routing.jsonc).`,
    `// 1. "lightSubagents": LIGHT mode (in-harness native subagent delegation) model tier & fallback mapping.`,
    `// 2. "agents" & "categories": HEAVY mode (external CLI parallel_spawn & cross-harness blind debate).`,
  ].join("\n");
}

function bootstrapGlobalPresets(
  homeDir: string,
  modelOptions?: {
    catalog?: HarnessModelCatalog;
    refreshModels?: boolean;
    strictSingleEntryCatalogs?: boolean;
  }
): {
  routingPath: string;
  mcpPath: string;
  modelsBootstrapped: RoutingModelRemap[];
  modelsRemapped: RoutingModelRemap[];
} {
  const asdHome = path.join(homeDir, ".asd");
  ensureDir(asdHome);
  ensureDir(path.join(asdHome, "state"));

  const routingPath = path.join(asdHome, "routing.jsonc");

  const asdRoot = getAsdRoot();
  const presetRouting = path.join(asdRoot, "presets", "default-routing.jsonc");

  let modelsBootstrapped: RoutingModelRemap[] = [];
  let modelsRemapped: RoutingModelRemap[] = [];

  if (!fs.existsSync(routingPath)) {
    if (fs.existsSync(presetRouting)) {
      const content = fs
        .readFileSync(presetRouting, "utf8")
        .replace(/\bASD v\d+\.\d+(?:\.\d+)?\b/g, `ASD v${ASD_VERSION}`)
        .replace(/"_asdVersion":\s*"[^"]*"/g, `"_asdVersion": "${ASD_VERSION}"`);

      let writtenViaDiscovery = false;
      if (modelOptions?.catalog) {
        try {
          const parsedPreset = parseJsonc<Record<string, unknown>>(content);
          if (parsedPreset && typeof parsedPreset === "object") {
            const subRes = inspectOrRemapRoutingModels(parsedPreset, modelOptions.catalog, {
              applyRemap: true,
              strictSingleEntryCatalogs: Boolean(modelOptions.strictSingleEntryCatalogs),
            });
            if (subRes.changed) {
              modelsBootstrapped = subRes.remapped;
              safeWriteText(
                routingPath,
                `${formatGlobalRoutingHeader()}\n${JSON.stringify(parsedPreset, null, 2)}\n`
              );
              writtenViaDiscovery = true;
            }
          }
        } catch {
          // Fall back to static preset text
        }
      }

      if (!writtenViaDiscovery) {
        safeWriteText(routingPath, content);
      }
    } else {
      safeWriteText(routingPath, `// ASD Default Routing\n{\n  "_asdVersion": "${ASD_VERSION}"\n}\n`);
    }
  } else {
    try {
      const existingRaw = fs.readFileSync(routingPath, "utf8");
      const parsed = parseJsonc<RoutingConfig & { _asdVersion?: string }>(existingRaw);
      if (parsed && typeof parsed === "object") {
        const needsVersionUpgrade =
          typeof parsed._asdVersion === "string" &&
          compareSemver(parsed._asdVersion, ASD_VERSION) < 0;
        const parsedRec = parsed as unknown as Record<string, unknown>;
        const modelsMigrated = migrateLegacyAntigravityCliModels(parsedRec);

        let explicitRefreshChanged = false;
        if (modelOptions?.refreshModels && modelOptions.catalog) {
          const refreshRes = inspectOrRemapRoutingModels(parsedRec, modelOptions.catalog, {
            applyRemap: true,
            strictSingleEntryCatalogs: Boolean(modelOptions.strictSingleEntryCatalogs),
          });
          if (refreshRes.changed) {
            explicitRefreshChanged = true;
            modelsRemapped = refreshRes.remapped;
          }
        }

        if (needsVersionUpgrade || modelsMigrated || explicitRefreshChanged) {
          let presetLightSubagents: RoutingConfig["lightSubagents"] | undefined;
          if (needsVersionUpgrade && fs.existsSync(presetRouting)) {
            try {
              const presetParsed = parseJsonc<RoutingConfig>(
                fs.readFileSync(presetRouting, "utf8")
              );
              presetLightSubagents = presetParsed?.lightSubagents;
            } catch {
              presetLightSubagents = undefined;
            }
          }

          const migrated: Record<string, unknown> = {
            _asdVersion: ASD_VERSION,
          };
          const mergedLightSubagents = needsVersionUpgrade
            ? parsed.lightSubagents
              ? { ...(presetLightSubagents ?? {}), ...parsed.lightSubagents }
              : presetLightSubagents
            : (parsedRec.lightSubagents as RoutingConfig["lightSubagents"]);
          if (mergedLightSubagents) {
            migrated.lightSubagents = mergedLightSubagents;
          }
          for (const [key, val] of Object.entries(parsedRec)) {
            if (key === "_asdVersion" || key === "lightSubagents") continue;
            migrated[key] = val;
          }

          safeWriteText(
            routingPath,
            `${formatGlobalRoutingHeader()}\n${JSON.stringify(migrated, null, 2)}\n`
          );
        }
      }
    } catch {
      // Preserve user file untouched if unparseable
    }
  }

  const mcpPath = bootstrapGlobalMcpPreset(homeDir, asdRoot);

  return { routingPath, mcpPath, modelsBootstrapped, modelsRemapped };
}

function computeConfigHash(
  homeDir: string,
  projectRoot?: string,
  asdCliPath?: string
): string {
  const { routingPath, mcpPath } = bootstrapGlobalPresets(homeDir);

  const hash = crypto.createHash("sha256");
  hash.update(ASD_VERSION);
  if (asdCliPath) {
    hash.update(asdCliPath.replaceAll("\\", "/"));
    hash.update(`ag-hook-v2:${buildAntigravityHookSpec(asdCliPath).cliArg}`);
    hash.update(generateOpencodeGuardPlugin(asdCliPath));
  }
  hash.update("no-ai-coauthor-v1");

  let parsedRouting: RoutingConfig | null = null;
  const localRoutingPath = projectRoot
    ? path.join(projectRoot, ".asd", "routing.jsonc")
    : null;
  if (localRoutingPath && fs.existsSync(localRoutingPath)) {
    const raw = fs.readFileSync(localRoutingPath);
    hash.update(raw);
    try {
      parsedRouting = parseJsonc<RoutingConfig>(raw.toString("utf8"));
    } catch {
      parsedRouting = null;
    }
  } else if (fs.existsSync(routingPath)) {
    const raw = fs.readFileSync(routingPath);
    hash.update(raw);
    try {
      parsedRouting = parseJsonc<RoutingConfig>(raw.toString("utf8"));
    } catch {
      parsedRouting = null;
    }
  }
  if (fs.existsSync(mcpPath)) {
    hash.update(fs.readFileSync(mcpPath));
  }

  for (const harnessId of DEFAULT_HARNESS_IDS) {
    for (const skill of ASD_SKILLS) {
      hash.update(getSkillTemplate(skill, { harnessId, routingConfig: parsedRouting }));
    }
    for (const role of AGENT_ROLES) {
      const route = resolveLightSubagentRoute(harnessId, role, parsedRouting);
      const model = route?.model;
      const fallbacks = route?.fallbacks.map((f) => f.model);
      hash.update(generateAgentContent(role, { harnessId, model, fallbacks }));
    }
  }

  return hash.digest("hex");
}

function loadLastSync(homeDir: string): LastSyncRecord | null {
  const lastSyncPath = path.join(homeDir, ".asd", "state", "last-sync.json");
  if (!fs.existsSync(lastSyncPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lastSyncPath, "utf8")) as LastSyncRecord;
  } catch {
    return null;
  }
}

function saveLastSync(homeDir: string, record: LastSyncRecord): void {
  const lastSyncPath = path.join(homeDir, ".asd", "state", "last-sync.json");
  safeWriteJson(lastSyncPath, record);
}

// Capability-Aware & Dedup External Catalog MCP Sync extracted to:
//   - ./installer/mcp-sync.ts

function getCliShimTargetDirs(homeDir: string): string[] {
  const dirs = [path.join(homeDir, ".asd", "bin")];
  const isRealHome = path.resolve(homeDir) === path.resolve(os.homedir());
  if (isRealHome) {
    if (process.platform === "win32") {
      const npmBin = path.join(
        process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"),
        "npm"
      );
      dirs.push(npmBin);
    } else {
      dirs.push(path.join(homeDir, ".local", "bin"));
    }
  }
  return dirs;
}

function installCliPathShims(homeDir: string, asdCliPath: string): string[] {
  const written: string[] = [];
  const normalizedCli = path.resolve(asdCliPath);
  const shContent = `#!/usr/bin/env sh\n# ASD-MANAGED-SHIM\nexec node --no-warnings "${normalizedCli.replaceAll("\\", "/")}" "$@"\n`;
  const cmdContent = `@ECHO off\r\nREM ASD-MANAGED-SHIM\r\nnode --no-warnings "${normalizedCli}" %*\r\n`;
  const ps1Content = `# ASD-MANAGED-SHIM\r\n& node --no-warnings "${normalizedCli}" @args\r\nexit $LASTEXITCODE\r\n`;

  for (const binDir of getCliShimTargetDirs(homeDir)) {
    try {
      ensureDir(binDir);
      const shPath = path.join(binDir, "asd");
      fs.writeFileSync(shPath, shContent, { encoding: "utf8", mode: 0o755 });
      written.push(shPath);

      if (process.platform === "win32") {
        const cmdPath = path.join(binDir, "asd.cmd");
        fs.writeFileSync(cmdPath, cmdContent, "utf8");
        written.push(cmdPath);

        const ps1Path = path.join(binDir, "asd.ps1");
        fs.writeFileSync(ps1Path, ps1Content, "utf8");
        written.push(ps1Path);
      }
    } catch {
      // Ignore permission issues on system bin directories
    }
  }
  return written;
}

function removeCliPathShims(homeDir: string, removedFiles: string[]): void {
  for (const binDir of getCliShimTargetDirs(homeDir)) {
    for (const name of ["asd", "asd.cmd", "asd.ps1"]) {
      const filePath = path.join(binDir, name);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes("ASD-MANAGED-SHIM")) {
          fs.unlinkSync(filePath);
          removedFiles.push(filePath);
        }
      } catch {
        // Ignore unlink errors
      }
    }
    try {
      if (
        binDir.endsWith(path.join(".asd", "bin")) &&
        fs.existsSync(binDir) &&
        fs.readdirSync(binDir).length === 0
      ) {
        fs.rmdirSync(binDir);
      }
    } catch {
      // Ignore
    }
  }
}

// ============================================================================
// Core Synchronizer: Strictly Global-Only
// ============================================================================

export async function syncHarnessConfigs(
  options?: SyncHarnessOptions
): Promise<SyncHarnessConfigsResult> {
  const homeDir = resolveHomeDir(options?.homeDir);
  const asdRoot = getAsdRoot();
  const asdCliPath =
    options?.asdCliPath || path.join(asdRoot, "src", "cli", "index.ts");

  // 1. Discover available models (pre-warming ~/.asd/state/models-cache.json),
  //    bootstrap presets (auto-substituting missing preset models ONLY on initial creation
  //    or explicit --refresh-models), and compute config hash.
  let discoveredCatalog: HarnessModelCatalog | undefined;
  const strictSingleEntryCatalogs = Boolean(options?.modelCatalogOverride);
  if (options?.modelCatalogOverride) {
    discoveredCatalog = options.modelCatalogOverride;
    writeModelsDiskCache(homeDir, discoveredCatalog, true);
  } else if (!options?.skipModelDiscovery) {
    const isInitialBootstrap = !fs.existsSync(path.join(homeDir, ".asd", "routing.jsonc"));
    const isRealHome = path.resolve(homeDir) === path.resolve(os.homedir());
    const shouldProbeClis = Boolean(
      options?.discoverModels || options?.refreshModels || (isInitialBootstrap && isRealHome)
    );
    try {
      discoveredCatalog = await discoverHarnessModels({
        homeDir,
        projectRoot: options?.projectRoot,
        forceRefresh: shouldProbeClis,
        skipCliSpawn: !shouldProbeClis,
        cliTimeoutMs: 10_000,
        persistCache: shouldProbeClis,
        excludeAsdRouting: true,
        enableGatewayProbe: shouldProbeClis ? "trusted-only" : false,
      });
    } catch {
      discoveredCatalog = undefined;
    }
  }

  const presetBootstrap = bootstrapGlobalPresets(homeDir, {
    catalog: discoveredCatalog,
    refreshModels: options?.refreshModels,
    strictSingleEntryCatalogs,
  });

  // Also support --refresh-models when a project-local .asd/routing.jsonc override is active
  const modelsRemapped: RoutingModelRemap[] = [...presetBootstrap.modelsRemapped];
  if (options?.refreshModels && discoveredCatalog && options?.projectRoot) {
    const localRoutingPath = path.join(options.projectRoot, ".asd", "routing.jsonc");
    if (fs.existsSync(localRoutingPath)) {
      try {
        const localParsed = parseJsonc<Record<string, unknown>>(
          fs.readFileSync(localRoutingPath, "utf8")
        );
        if (localParsed && typeof localParsed === "object") {
          const localRes = inspectOrRemapRoutingModels(localParsed, discoveredCatalog, {
            applyRemap: true,
            strictSingleEntryCatalogs,
          });
          if (localRes.changed) {
            safeWriteText(
              localRoutingPath,
              `// Project-Scoped ASD Routing Override (.asd/routing.jsonc)\n${JSON.stringify(localParsed, null, 2)}\n`
            );
            for (const item of localRes.remapped) {
              modelsRemapped.push({ ...item, location: `project:${item.location}` });
            }
          }
        }
      } catch {
        // Ignore unparseable local routing override
      }
    }
  }

  const configHash = computeConfigHash(homeDir, options?.projectRoot, asdCliPath);
  const lastSync = loadLastSync(homeDir);
  const nativeCapabilitiesMap = loadHarnessNativeCapabilities();
  const catalogMcpServers = loadCatalogMcpServers(homeDir, asdRoot);

  // Load routingConfig (local override if projectRoot provided, else global ~/.asd/routing.jsonc)
  let routingConfig: RoutingConfig | null = null;
  try {
    const localRoutingPath = options?.projectRoot
      ? path.join(options.projectRoot, ".asd", "routing.jsonc")
      : null;
    const globalRoutingPath = path.join(homeDir, ".asd", "routing.jsonc");
    if (localRoutingPath && fs.existsSync(localRoutingPath)) {
      routingConfig = parseJsonc<RoutingConfig>(fs.readFileSync(localRoutingPath, "utf8"));
    } else if (fs.existsSync(globalRoutingPath)) {
      routingConfig = parseJsonc<RoutingConfig>(fs.readFileSync(globalRoutingPath, "utf8"));
    }
  } catch {
    routingConfig = null;
  }

  let modelWarnings: RoutingModelWarning[] = [];
  if (discoveredCatalog && routingConfig && typeof routingConfig === "object") {
    const checkRes = inspectOrRemapRoutingModels(
      routingConfig as unknown as Record<string, unknown>,
      discoveredCatalog,
      {
        applyRemap: false,
        strictSingleEntryCatalogs,
      }
    );
    modelWarnings = checkRes.warnings;
  }

  const harnessResults: Record<HarnessId, HarnessSyncStatus> = {
    "claude-code": { harness: "claude-code", status: "skipped", skipped: true, filesWritten: [] },
    opencode: { harness: "opencode", status: "skipped", skipped: true, filesWritten: [] },
    codex: { harness: "codex", status: "skipped", skipped: true, filesWritten: [] },
    antigravity: { harness: "antigravity", status: "skipped", skipped: true, filesWritten: [] },
    cursor: { harness: "cursor", status: "skipped", skipped: true, filesWritten: [] },
  };

  const adapters: Record<HarnessId, HarnessAdapter> = {
    "claude-code": claudeCodeAdapter,
    opencode: opencodeAdapter,
    codex: codexAdapter,
    antigravity: antigravityAdapter,
    cursor: cursorAdapter,
  };

  let anyUpdated = false;

  for (const harnessId of DEFAULT_HARNESS_IDS) {
    const adapter = adapters[harnessId];
    const targets = adapter.globalConfigTargets(homeDir);
    const nativeCaps = nativeCapabilitiesMap[harnessId] ?? new Set<string>();

    const isHashMatched =
      !options?.force &&
      lastSync !== null &&
      lastSync.configHash === configHash &&
      lastSync.harnesses?.[harnessId]?.hash === configHash;

    const agLauncherRequired =
      harnessId === "antigravity" &&
      buildAntigravityHookSpec(asdCliPath).launcherSource !== null;
    const allTargetsExist =
      fs.existsSync(asdCliPath) &&
      targets.every((targetPath) => fs.existsSync(targetPath)) &&
      (!agLauncherRequired ||
        fs.existsSync(path.join(homeDir, ".gemini", "config", "asd-hook.mjs")));

    // Check for user config divergence: compare current user config file hashes with last sync
    let userConfigDiverged = false;
    if (isHashMatched && allTargetsExist && lastSync?.harnesses?.[harnessId]?.userConfigHashes) {
      const currentHashes = computeUserConfigHashes(homeDir, harnessId);
      const lastHashes = lastSync.harnesses[harnessId]!.userConfigHashes!;
      for (const [filePath, lastHash] of Object.entries(lastHashes)) {
        const currentHash = currentHashes[filePath];
        if (currentHash !== undefined && currentHash !== lastHash) {
          userConfigDiverged = true;
          break;
        }
      }
    }

    if (isHashMatched && allTargetsExist && !userConfigDiverged) {
      harnessResults[harnessId] = {
        harness: harnessId,
        status: "skipped",
        skipped: true,
        filesWritten: [],
      };
      continue;
    }

    // Bake in harness configurations
    anyUpdated = true;
    const written: string[] = [];

    switch (harnessId) {
      case "claude-code": {
        const claudeDir = path.join(homeDir, ".claude");
        cleanupLegacyAgentFiles(path.join(claudeDir, "agents"));

        // 5 agent files (with highest-priority claude-code model from routing.jsonc)
        for (const role of AGENT_ROLES) {
          const agentPath = path.join(claudeDir, "agents", `asd-${role}.md`);
          const route = resolveLightSubagentRoute("claude-code", role, routingConfig);
          const model = route?.model;
          const fallbacks = route?.fallbacks.map((f) => f.model);
          safeWriteText(agentPath, generateAgentContent(role, { harnessId: "claude-code", model, fallbacks }));
          written.push(agentPath);
        }

        // All ASD skills
        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(claudeDir, "skills", skill, "SKILL.md");
          safeWriteText(
            skillPath,
            getSkillTemplate(skill, { harnessId: "claude-code", routingConfig })
          );
          written.push(skillPath);
        }

        // settings.json
        const settingsPath = path.join(claudeDir, "settings.json");
        let existingSettings: Record<string, unknown> | null = null;
        if (fs.existsSync(settingsPath)) {
          try {
            existingSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
          } catch {
            existingSettings = {};
          }
        }
        const mergedSettings = mergeClaudeSettings(existingSettings, asdCliPath);
        backupUserFile(settingsPath, JSON.stringify(mergedSettings, null, 2) + "\n");
        safeWriteJson(settingsPath, mergedSettings);
        written.push(settingsPath);

        // ~/.claude.json & ~/.claude/.mcp.json
        for (const mcpPath of [path.join(homeDir, ".claude.json"), path.join(claudeDir, ".mcp.json")]) {
          syncJsonMcpConfigFile({
            filePath: mcpPath,
            harnessId: "claude-code",
            catalog: catalogMcpServers,
            nativeCapabilities: nativeCaps,
          });
          written.push(mcpPath);
        }

        break;
      }

      case "opencode": {
        const opencodeDir = path.join(homeDir, ".config", "opencode");

        // All ASD command files
        for (const skill of ASD_SKILLS) {
          const cmdPath = path.join(opencodeDir, "command", `${skill}.md`);
          safeWriteText(
            cmdPath,
            getSkillTemplate(skill, { harnessId: "opencode", routingConfig })
          );
          written.push(cmdPath);
        }

        // 5 native OpenCode subagent files (with highest-priority opencode model from routing.jsonc)
        cleanupLegacyAgentFiles(path.join(opencodeDir, "agent"));
        for (const role of AGENT_ROLES) {
          const agentPath = path.join(opencodeDir, "agent", `asd-${role}.md`);
          const route = resolveLightSubagentRoute("opencode", role, routingConfig);
          const model = route?.model;
          const fallbacks = route?.fallbacks.map((f) => f.model);
          safeWriteText(agentPath, generateAgentContent(role, { harnessId: "opencode", model, fallbacks }));
          written.push(agentPath);
        }

        // AGENTS.md
        const agentsMdPath = path.join(opencodeDir, "AGENTS.md");
        safeWriteText(agentsMdPath, generateAllAgentsMarkdown(routingConfig, "opencode"));
        written.push(agentsMdPath);

        // ASD Policy Guard Plugin (PreToolUse + Stop hooks)
        const opencodePluginPath = path.join(opencodeDir, "plugin", "asd-guard.js");
        safeWriteText(opencodePluginPath, generateOpencodeGuardPlugin(asdCliPath));
        written.push(opencodePluginPath);

        // opencode.json & opencode.jsonc
        const opencodeJsoncPath = path.join(opencodeDir, "opencode.jsonc");
        const opencodeJsoncKeys = new Set<string>();
        if (fs.existsSync(opencodeJsoncPath)) {
          try {
            const parsedJsonc = parseJsonc(fs.readFileSync(opencodeJsoncPath, "utf8"));
            if (parsedJsonc && typeof parsedJsonc === "object" && !Array.isArray(parsedJsonc)) {
              const rec = parsedJsonc as Record<string, unknown>;
              if (rec.mcp && typeof rec.mcp === "object") {
                for (const k of Object.keys(rec.mcp as Record<string, unknown>)) {
                  opencodeJsoncKeys.add(k);
                }
              }
              if (rec.mcpServers && typeof rec.mcpServers === "object") {
                for (const [k, v] of Object.entries(rec.mcpServers as Record<string, unknown>)) {
                  if (!(v && typeof v === "object" && (v as Record<string, unknown>)._asdManaged === true)) {
                    opencodeJsoncKeys.add(k);
                  }
                }
              }
            }
          } catch {
            // ignore malformed opencode.jsonc
          }
        }
        const opencodeJsonPath = path.join(opencodeDir, "opencode.json");
        // Compute the expected merged content for backup comparison
        let expectedOpencodeJson: Record<string, unknown> = { _asdVersion: ASD_VERSION };
        if (fs.existsSync(opencodeJsonPath)) {
          try {
            expectedOpencodeJson = JSON.parse(fs.readFileSync(opencodeJsonPath, "utf8")) as Record<string, unknown>;
          } catch {
            expectedOpencodeJson = { _asdVersion: ASD_VERSION };
          }
        }
        // Apply the same mutations that syncJsonMcpConfigFile will apply
        if (expectedOpencodeJson.mcp && typeof expectedOpencodeJson.mcp === "object") {
          for (const k of Object.keys(expectedOpencodeJson.mcp as Record<string, unknown>)) {
            opencodeJsoncKeys.add(k);
          }
        }
        // We can't easily compute the full merged result without duplicating syncJsonMcpConfigFile logic
        // So we'll pass undefined for asdManagedContent for opencode.jsonc (backup will be created if missing)
        backupUserFile(opencodeJsoncPath);
        syncJsonMcpConfigFile({
          filePath: opencodeJsonPath,
          harnessId: "opencode",
          catalog: catalogMcpServers,
          nativeCapabilities: nativeCaps,
          externalExistingKeys: opencodeJsoncKeys,
          mutateBeforeMerge: (cfg, extKeys) => {
            cfg._asdVersion = ASD_VERSION;
            if (cfg.mcp && typeof cfg.mcp === "object") {
              for (const k of Object.keys(cfg.mcp as Record<string, unknown>)) {
                extKeys.add(k);
              }
            }
          },
        });
        written.push(opencodeJsonPath);

        // If Oh-My-OpenAgent / Oh-My-OpenCode plugin is configured, disable Sisyphus git_master Co-authored-by footers
        const omoConfigPath = path.join(opencodeDir, "oh-my-openagent.json");
        const opencodeJsoncRaw = fs.existsSync(opencodeJsoncPath)
          ? fs.readFileSync(opencodeJsoncPath, "utf8")
          : "";
        const opencodeJsonRaw = fs.existsSync(opencodeJsonPath)
          ? fs.readFileSync(opencodeJsonPath, "utf8")
          : "";
        const hasOhMyOpenAgent =
          fs.existsSync(omoConfigPath) ||
          /oh-my-open(?:agent|code)/i.test(opencodeJsoncRaw) ||
          /oh-my-open(?:agent|code)/i.test(opencodeJsonRaw);
        if (hasOhMyOpenAgent) {
          let omoCfg: Record<string, unknown> = {};
          if (fs.existsSync(omoConfigPath)) {
            try {
              const parsedOmo = parseJsonc(fs.readFileSync(omoConfigPath, "utf8"));
              if (parsedOmo && typeof parsedOmo === "object" && !Array.isArray(parsedOmo)) {
                omoCfg = { ...(parsedOmo as Record<string, unknown>) };
              }
            } catch {
              omoCfg = {};
            }
          }
          const existingGitMaster =
            omoCfg.git_master && typeof omoCfg.git_master === "object" && !Array.isArray(omoCfg.git_master)
              ? { ...(omoCfg.git_master as Record<string, unknown>) }
              : {};
          if (existingGitMaster.commit_footer === undefined) {
            existingGitMaster.commit_footer = false;
          }
          if (existingGitMaster.include_co_authored_by === undefined) {
            existingGitMaster.include_co_authored_by = false;
          }
          omoCfg.git_master = existingGitMaster;
          backupUserFile(omoConfigPath, JSON.stringify(omoCfg, null, 2) + "\n");
          safeWriteJson(omoConfigPath, omoCfg);
          written.push(omoConfigPath);
        }

        break;
      }

      case "codex": {
        const codexDir = path.join(homeDir, ".codex");

        // All ASD skills
        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(codexDir, "skills", skill, "SKILL.md");
          safeWriteText(
            skillPath,
            getSkillTemplate(skill, { harnessId: "codex", routingConfig })
          );
          written.push(skillPath);
        }

        // AGENTS.md
        const agentsMdPath = path.join(codexDir, "AGENTS.md");
        safeWriteText(agentsMdPath, generateAllAgentsMarkdown(routingConfig, "codex"));
        written.push(agentsMdPath);

        // config.toml
        const configTomlPath = path.join(codexDir, "config.toml");
        let existingToml = "";
        if (fs.existsSync(configTomlPath)) {
          try {
            existingToml = fs.readFileSync(configTomlPath, "utf8");
          } catch {
            existingToml = "";
          }
        }
        const unmanagedToml = removeTomlFence(existingToml);
        const managedTomlBlock = buildCodexManagedTomlBlock({
          unmanagedToml,
          catalog: catalogMcpServers,
          nativeCapabilities: nativeCaps,
          asdCliPath,
        });
        const mergedToml = upsertTomlFence(existingToml, managedTomlBlock, ASD_VERSION);
        backupUserFile(configTomlPath, mergedToml);
        safeWriteText(configTomlPath, mergedToml);
        written.push(configTomlPath);

        break;
      }

      case "antigravity": {
        const geminiDir = path.join(homeDir, ".gemini");
        const legacyAgentsDir = path.join(geminiDir, "agents");
        const configAgentsDir = path.join(geminiDir, "config", "agents");

        cleanupLegacyAgentFiles(legacyAgentsDir);
        cleanupLegacyAgentFiles(configAgentsDir);

        // Remove any legacy ~/.gemini/agents/asd-<role>.md files so only ~/.gemini/config/agents/ is active
        for (const role of AGENT_ROLES) {
          const legacyAgentPath = path.join(legacyAgentsDir, `asd-${role}.md`);
          if (fs.existsSync(legacyAgentPath)) {
            try {
              fs.unlinkSync(legacyAgentPath);
            } catch {
              // Ignore removal error
            }
          }
        }
        try {
          if (fs.existsSync(legacyAgentsDir) && fs.readdirSync(legacyAgentsDir).length === 0) {
            fs.rmdirSync(legacyAgentsDir);
          }
        } catch {
          // Ignore
        }

        // 5 agents under ~/.gemini/config/agents/ (with normalized Antigravity tier from lightSubagents / routing.jsonc)
        for (const role of AGENT_ROLES) {
          const agentPath = path.join(configAgentsDir, `asd-${role}.md`);
          const route = resolveLightSubagentRoute("antigravity", role, routingConfig);
          const model = route?.model;
          const fallbacks = route?.fallbacks.map((f) => f.model);
          safeWriteText(agentPath, generateAgentContent(role, { harnessId: "antigravity", model, fallbacks }));
          written.push(agentPath);
        }

        // All ASD skills
        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(geminiDir, "skills", skill, "SKILL.md");
          safeWriteText(
            skillPath,
            getSkillTemplate(skill, { harnessId: "antigravity", routingConfig })
          );
          written.push(skillPath);
        }

        // Clean up legacy ~/.gemini/hooks.json if present (consolidated into ~/.gemini/config/hooks.json)
        const legacyHooksJsonPath = path.join(geminiDir, "hooks.json");
        if (fs.existsSync(legacyHooksJsonPath)) {
          try {
            const lJson = JSON.parse(fs.readFileSync(legacyHooksJsonPath, "utf8")) as Record<string, unknown>;
            for (const key of ["SessionStart", "PreToolUse", "Stop"] as const) {
              if (Array.isArray(lJson[key])) {
                lJson[key] = (lJson[key] as unknown[]).filter(
                  (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
                );
                if ((lJson[key] as unknown[]).length === 0) {
                  delete lJson[key];
                }
              }
            }
            if (Object.keys(lJson).length === 0) {
              fs.unlinkSync(legacyHooksJsonPath);
              const backupHooksPath = `${legacyHooksJsonPath}.asd-backup`;
              if (fs.existsSync(backupHooksPath)) {
                fs.unlinkSync(backupHooksPath);
              }
            } else {
              safeWriteJson(legacyHooksJsonPath, lJson);
            }
          } catch {
            // Ignore cleanup failure on legacy hooks.json
          }
        }

        const configHooksJsonPath = path.join(geminiDir, "config", "hooks.json");
        let existingConfigHooks: Record<string, unknown> = {};
        if (fs.existsSync(configHooksJsonPath)) {
          try {
            existingConfigHooks = JSON.parse(
              fs.readFileSync(configHooksJsonPath, "utf8").replace(/^\uFEFF/, "")
            ) as Record<string, unknown>;
          } catch {
            existingConfigHooks = {};
          }
        }
        const agHookSpec = buildAntigravityHookSpec(asdCliPath);
        const agHookLauncherPath = path.join(geminiDir, "config", "asd-hook.mjs");
        if (agHookSpec.launcherSource !== null) {
          safeWriteText(agHookLauncherPath, agHookSpec.launcherSource);
          written.push(agHookLauncherPath);
        } else if (fs.existsSync(agHookLauncherPath)) {
          try {
            fs.unlinkSync(agHookLauncherPath);
          } catch {
            // Ignore stale launcher cleanup error
          }
        }
        existingConfigHooks["asd-session-tracker"] = {
          SessionStart: [
            {
              type: "command",
              command: `node --no-warnings ${agHookSpec.cliArg} hook session-start --harness antigravity`,
              timeout: 10,
            },
          ],
          PreToolUse: [
            {
              matcher:
                "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|run_command|invoke_subagent",
              hooks: [
                {
                  type: "command",
                  command: `node --no-warnings ${agHookSpec.cliArg} hook pre-tool-use --harness antigravity`,
                  timeout: 10,
                },
              ],
            },
          ],
          Stop: [
            {
              type: "command",
              command: `node --no-warnings ${agHookSpec.cliArg} hook stop --harness antigravity`,
              timeout: 10,
            },
          ],
        };
        const mergedConfigHooks = JSON.stringify(existingConfigHooks, null, 2) + "\n";
        backupUserFile(configHooksJsonPath, mergedConfigHooks);
        safeWriteJson(configHooksJsonPath, existingConfigHooks);
        written.push(configHooksJsonPath);

        // Check external Antigravity MCP config files (e.g., ~/.gemini/config/mcp_config.json or ~/.gemini/antigravity-cli/mcp_config.json)
        // so we never inject duplicates of tools already configured by the user or OMO-for-AGY.
        const externalGeminiKeys = new Set<string>();
        for (const extPath of [
          path.join(geminiDir, "config", "mcp_config.json"),
          path.join(geminiDir, "antigravity-cli", "mcp_config.json"),
        ]) {
          if (fs.existsSync(extPath)) {
            try {
              const extJson = JSON.parse(fs.readFileSync(extPath, "utf8")) as Record<string, unknown>;
              if (extJson.mcpServers && typeof extJson.mcpServers === "object") {
                for (const k of Object.keys(extJson.mcpServers as Record<string, unknown>)) {
                  externalGeminiKeys.add(k);
                }
              }
            } catch {
              // Ignore unreadable external file
            }
          }
        }

        // mcp_config.json (both legacy ~/.gemini/mcp_config.json and modern ~/.gemini/config/mcp_config.json)
        for (const mcpConfigPath of [
          path.join(geminiDir, "mcp_config.json"),
          path.join(geminiDir, "config", "mcp_config.json"),
        ]) {
          syncJsonMcpConfigFile({
            filePath: mcpConfigPath,
            harnessId: "antigravity",
            catalog: catalogMcpServers,
            nativeCapabilities: nativeCaps,
            externalExistingKeys: externalGeminiKeys,
          });
          written.push(mcpConfigPath);
        }

        break;
      }

      case "cursor": {
        const cursorDir = path.join(homeDir, ".cursor");
        cleanupLegacyAgentFiles(path.join(cursorDir, "agents"));

        for (const role of AGENT_ROLES) {
          const agentPath = path.join(cursorDir, "agents", `asd-${role}.md`);
          const route = resolveLightSubagentRoute("cursor", role, routingConfig);
          const model = route?.model;
          const fallbacks = route?.fallbacks.map((f) => f.model);
          safeWriteText(agentPath, generateAgentContent(role, { harnessId: "cursor", model, fallbacks }));
          written.push(agentPath);
        }

        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(cursorDir, "skills", skill, "SKILL.md");
          safeWriteText(
            skillPath,
            getSkillTemplate(skill, { harnessId: "cursor", routingConfig })
          );
          written.push(skillPath);
        }

        const hooksJsonPath = path.join(cursorDir, "hooks.json");
        let existingHooks: Record<string, unknown> = {};
        if (fs.existsSync(hooksJsonPath)) {
          try {
            existingHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8")) as Record<string, unknown>;
          } catch {
            existingHooks = {};
          }
        }
        // Clean up any legacy flat Claude-style keys from older ASD syncs
        for (const legacyKey of ["SessionStart", "PreToolUse", "Stop"] as const) {
          if (Array.isArray(existingHooks[legacyKey])) {
            const remaining = (existingHooks[legacyKey] as unknown[]).filter(
              (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
            );
            if (remaining.length === 0) {
              delete existingHooks[legacyKey];
            } else {
              existingHooks[legacyKey] = remaining;
            }
          }
        }

        const nestedHooks: Record<string, unknown> =
          existingHooks.hooks &&
          typeof existingHooks.hooks === "object" &&
          !Array.isArray(existingHooks.hooks)
            ? { ...(existingHooks.hooks as Record<string, unknown>) }
            : {};

        const upsertCursorHook = (eventKey: string, cmd: string) => {
          const prev = Array.isArray(nestedHooks[eventKey])
            ? (nestedHooks[eventKey] as unknown[]).filter(
                (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
              )
            : [];
          prev.push({
            command: cmd,
            _asdManaged: true,
          });
          nestedHooks[eventKey] = prev;
        };

        upsertCursorHook(
          "sessionStart",
          `node --no-warnings "${asdCliPath}" hook session-start --harness cursor`
        );
        upsertCursorHook(
          "preToolUse",
          `node --no-warnings "${asdCliPath}" hook pre-tool-use --harness cursor`
        );
        upsertCursorHook(
          "beforeShellExecution",
          `node --no-warnings "${asdCliPath}" hook pre-tool-use --harness cursor`
        );
        upsertCursorHook(
          "stop",
          `node --no-warnings "${asdCliPath}" hook stop --harness cursor`
        );

        existingHooks.version =
          typeof existingHooks.version === "number" ? existingHooks.version : 1;
        existingHooks.hooks = nestedHooks;
        const mergedHooks = JSON.stringify(existingHooks, null, 2) + "\n";
        backupUserFile(hooksJsonPath, mergedHooks);
        safeWriteJson(hooksJsonPath, existingHooks);
        written.push(hooksJsonPath);

        const mcpJsonPath = path.join(cursorDir, "mcp.json");
        syncJsonMcpConfigFile({
          filePath: mcpJsonPath,
          harnessId: "cursor",
          catalog: catalogMcpServers,
          nativeCapabilities: nativeCaps,
        });
        written.push(mcpJsonPath);

        const cliConfigPath = path.join(cursorDir, "cli-config.json");
        let cliCfg: Record<string, unknown> = {};
        if (fs.existsSync(cliConfigPath)) {
          try {
            cliCfg = JSON.parse(fs.readFileSync(cliConfigPath, "utf8")) as Record<string, unknown>;
          } catch {
            cliCfg = {};
          }
        }
        cliCfg._asdVersion = ASD_VERSION;
        const mergedCliCfg = JSON.stringify(cliCfg, null, 2) + "\n";
        backupUserFile(cliConfigPath, mergedCliCfg);
        safeWriteJson(cliConfigPath, cliCfg);
        written.push(cliConfigPath);

        break;
      }
    }

    harnessResults[harnessId] = {
      harness: harnessId,
      status: "updated",
      skipped: false,
      filesWritten: written,
    };
  }

  // Save state with user config hashes for divergence detection
  const updatedLastSync: LastSyncRecord = {
    _asdVersion: ASD_VERSION,
    configHash,
    lastSyncedAt: new Date().toISOString(),
    harnesses: {
      ...lastSync?.harnesses,
      "claude-code": { hash: configHash, syncedAt: new Date().toISOString(), userConfigHashes: computeUserConfigHashes(homeDir, "claude-code") },
      opencode: { hash: configHash, syncedAt: new Date().toISOString(), userConfigHashes: computeUserConfigHashes(homeDir, "opencode") },
      codex: { hash: configHash, syncedAt: new Date().toISOString(), userConfigHashes: computeUserConfigHashes(homeDir, "codex") },
      antigravity: { hash: configHash, syncedAt: new Date().toISOString(), userConfigHashes: computeUserConfigHashes(homeDir, "antigravity") },
      cursor: { hash: configHash, syncedAt: new Date().toISOString(), userConfigHashes: computeUserConfigHashes(homeDir, "cursor") },
    },
  };
  saveLastSync(homeDir, updatedLastSync);

  // Install global PATH CLI shims unless --no-path is specified
  const cliShimsInstalled = options?.noPath
    ? []
    : installCliPathShims(homeDir, asdCliPath);

  const acpSummary = probeAllHarnessesAcp(options?.env ?? process.env);

  return {
    status: anyUpdated ? "updated" : "skipped",
    skipped: !anyUpdated,
    configHash,
    harnesses: harnessResults,
    cliShimsInstalled,
    acpReadiness: acpSummary.acpReadiness,
    ...(acpSummary.acpBridgeHints.length > 0
      ? { acpBridgeHints: acpSummary.acpBridgeHints }
      : {}),
    ...(presetBootstrap.modelsBootstrapped.length > 0
      ? { modelsBootstrapped: presetBootstrap.modelsBootstrapped }
      : {}),
    ...(modelsRemapped.length > 0 ? { modelsRemapped } : {}),
    ...(modelWarnings.length > 0 ? { modelWarnings } : {}),
  };
}

export const runAsdSync = syncHarnessConfigs;

// ============================================================================
// Main-Session Auto-Sync
// ============================================================================

export async function autoSyncIfNeeded(options?: AutoSyncOptions): Promise<AutoSyncResult> {
  if (process.env.ASD_SESSION_ROLE === "subagent") {
    return {
      synced: false,
      skipped: true,
      reason: "subagent_shield",
    };
  }

  const syncResult = await syncHarnessConfigs({
    ...options,
    skipModelDiscovery: options?.skipModelDiscovery ?? true,
  });
  return {
    synced: syncResult.status === "updated",
    skipped: syncResult.status === "skipped",
    result: syncResult,
  };
}

/**
 * Lightweight, sub-5ms synchronizer that refreshes `model:` and `**Fallbacks**`
 * in global agent markdown files (`~/.claude/agents/asd-<role>.md`,
 * `~/.config/opencode/agent/asd-<role>.md`, `~/.gemini/config/agents/asd-<role>.md`,
 * `~/.cursor/agents/asd-<role>.md`, and `AGENTS.md`) whenever `routing.jsonc`
 * (global or project-local) has changed.
 *
 * Called automatically during `asd plan`, `asd dispatch`, and `saveProjectRoutingConfig`
 * so edits to `routing.jsonc` take effect immediately in LIGHT mode without requiring
 * a manual `asd sync`.
 */
export function syncAgentModelsIfNeeded(options?: {
  homeDir?: string;
  projectRoot?: string;
  force?: boolean;
}): { updated: boolean; filesWritten: string[] } {
  if (process.env.ASD_SESSION_ROLE === "subagent") {
    return { updated: false, filesWritten: [] };
  }

  const homeDir = resolveHomeDir(options?.homeDir);
  const localRoutingPath = options?.projectRoot
    ? path.join(options.projectRoot, ".asd", "routing.jsonc")
    : null;
  const globalRoutingPath = path.join(homeDir, ".asd", "routing.jsonc");

  const hasLocal = Boolean(localRoutingPath && fs.existsSync(localRoutingPath));
  const hasGlobal = fs.existsSync(globalRoutingPath);
  if (!hasLocal && !hasGlobal && !options?.force) {
    return { updated: false, filesWritten: [] };
  }

  const activeRoutingPath = hasLocal ? localRoutingPath! : globalRoutingPath;
  let rawRouting = "";
  let routingConfig: RoutingConfig | null = null;
  try {
    if (fs.existsSync(activeRoutingPath)) {
      rawRouting = fs.readFileSync(activeRoutingPath, "utf8");
      routingConfig = parseJsonc<RoutingConfig>(rawRouting);
    }
  } catch {
    routingConfig = null;
  }

  const hash = crypto
    .createHash("sha256")
    .update(ASD_VERSION)
    .update(activeRoutingPath)
    .update(rawRouting)
    .digest("hex");

  const hashFile = path.join(homeDir, ".asd", "state", "last-routing-hash.txt");
  if (!options?.force && fs.existsSync(hashFile)) {
    try {
      if (fs.readFileSync(hashFile, "utf8").trim() === hash) {
        return { updated: false, filesWritten: [] };
      }
    } catch {
      // ignore read error
    }
  }

  const filesWritten: string[] = [];
  const writeIfChanged = (filePath: string, nextContent: string) => {
    try {
      if (fs.existsSync(filePath)) {
        const cur = fs.readFileSync(filePath, "utf8");
        if (cur === nextContent) return;
      }
      safeWriteText(filePath, nextContent);
      filesWritten.push(filePath);
    } catch {
      // ignore write error
    }
  };

  const harnessAgentTargets: Array<{ harnessId: HarnessId; dirPath: string }> = [
    { harnessId: "claude-code", dirPath: path.join(homeDir, ".claude", "agents") },
    { harnessId: "opencode", dirPath: path.join(homeDir, ".config", "opencode", "agent") },
    { harnessId: "antigravity", dirPath: path.join(homeDir, ".gemini", "config", "agents") },
    { harnessId: "cursor", dirPath: path.join(homeDir, ".cursor", "agents") },
  ];

  const hasSyncedOnce = fs.existsSync(path.join(homeDir, ".asd", "state", "last-sync.json"));

  for (const { harnessId, dirPath } of harnessAgentTargets) {
    if (!options?.force && !hasSyncedOnce && !fs.existsSync(dirPath)) continue;
    for (const role of AGENT_ROLES) {
      const route = resolveLightSubagentRoute(harnessId, role, routingConfig);
      const content = generateAgentContent(role, {
        harnessId,
        model: route?.model,
        fallbacks: route?.fallbacks.map((f) => f.model),
      });
      writeIfChanged(path.join(dirPath, `asd-${role}.md`), content);
    }
  }

  const opencodeDir = path.join(homeDir, ".config", "opencode");
  if (options?.force || hasSyncedOnce || fs.existsSync(path.join(opencodeDir, "AGENTS.md"))) {
    writeIfChanged(
      path.join(opencodeDir, "AGENTS.md"),
      generateAllAgentsMarkdown(routingConfig, "opencode")
    );
  }

  const codexDir = path.join(homeDir, ".codex");
  if (options?.force || hasSyncedOnce || fs.existsSync(path.join(codexDir, "AGENTS.md"))) {
    writeIfChanged(
      path.join(codexDir, "AGENTS.md"),
      generateAllAgentsMarkdown(routingConfig, "codex")
    );
  }

  // Keep harness-targeted skill files synchronized with dynamic routing.jsonc models
  const harnessSkillTargets: Array<{
    harnessId: HarnessId;
    dirPath: string;
    fileForSkill: (skill: string) => string;
  }> = [
    {
      harnessId: "claude-code",
      dirPath: path.join(homeDir, ".claude", "skills"),
      fileForSkill: (s) => path.join(homeDir, ".claude", "skills", s, "SKILL.md"),
    },
    {
      harnessId: "opencode",
      dirPath: path.join(opencodeDir, "command"),
      fileForSkill: (s) => path.join(opencodeDir, "command", `${s}.md`),
    },
    {
      harnessId: "codex",
      dirPath: path.join(codexDir, "skills"),
      fileForSkill: (s) => path.join(codexDir, "skills", s, "SKILL.md"),
    },
    {
      harnessId: "antigravity",
      dirPath: path.join(homeDir, ".gemini", "skills"),
      fileForSkill: (s) => path.join(homeDir, ".gemini", "skills", s, "SKILL.md"),
    },
    {
      harnessId: "cursor",
      dirPath: path.join(homeDir, ".cursor", "skills"),
      fileForSkill: (s) => path.join(homeDir, ".cursor", "skills", s, "SKILL.md"),
    },
  ];

  for (const { harnessId, dirPath, fileForSkill } of harnessSkillTargets) {
    if (!options?.force && !hasSyncedOnce && !fs.existsSync(dirPath)) continue;
    for (const skill of ASD_SKILLS) {
      writeIfChanged(
        fileForSkill(skill),
        getSkillTemplate(skill, { harnessId, routingConfig })
      );
    }
  }

  try {
    safeWriteText(hashFile, `${hash}\n`);
  } catch {
    // ignore
  }

  return { updated: filesWritten.length > 0, filesWritten };
}

// ============================================================================
// Surgical Rollback: uninstallHarnessConfigs / runAsdUninstall
// ============================================================================

export async function uninstallHarnessConfigs(
  options?: UninstallHarnessOptions
): Promise<UninstallHarnessConfigsResult> {
  const homeDir = resolveHomeDir(options?.homeDir);

  const removedFiles: string[] = [];
  const restoredFiles: string[] = [];

  const harnessStatus: Record<HarnessId, UninstallHarnessStatus> = {
    "claude-code": { removed: [], restored: [] },
    opencode: { removed: [], restored: [] },
    codex: { removed: [], restored: [] },
    antigravity: { removed: [], restored: [] },
    cursor: { removed: [], restored: [] },
  };

  const removeFile = (filePath: string, harness: HarnessId) => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        removedFiles.push(filePath);
        harnessStatus[harness].removed.push(filePath);
      } catch {
        // Ignore unlink error
      }
    }
  };

  const removeDirIfEmpty = (dirPath: string) => {
    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {
      // Ignore directory removal error
    }
  };

  const removeBackupFile = (filePath: string) => {
    const backupPath = `${filePath}.asd-backup`;
    if (fs.existsSync(backupPath)) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Ignore
      }
    }
  };

  // 1. Claude Code
  const claudeDir = path.join(homeDir, ".claude");
  for (const role of AGENT_ROLES) {
    removeFile(path.join(claudeDir, "agents", `asd-${role}.md`), "claude-code");
  }
  removeDirIfEmpty(path.join(claudeDir, "agents"));

  for (const skill of ASD_SKILLS) {
    removeFile(path.join(claudeDir, "skills", skill, "SKILL.md"), "claude-code");
    removeDirIfEmpty(path.join(claudeDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(claudeDir, "skills"));

  const claudeSettings = path.join(claudeDir, "settings.json");
  if (fs.existsSync(claudeSettings)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
      if (cfg.hooks && typeof cfg.hooks === "object") {
        const hooks = cfg.hooks as Record<string, unknown[]>;
        if (Array.isArray(hooks.SessionStart)) {
          hooks.SessionStart = hooks.SessionStart.filter(
            (h: unknown) => !isAsdManagedClaudeHook(h)
          );
          if (hooks.SessionStart.length === 0) delete hooks.SessionStart;
        }
        if (Array.isArray(hooks.PreToolUse)) {
          hooks.PreToolUse = hooks.PreToolUse.filter(
            (h: unknown) => !isAsdManagedClaudeHook(h)
          );
          if (hooks.PreToolUse.length === 0) delete hooks.PreToolUse;
        }
        if (Array.isArray(hooks.Stop)) {
          hooks.Stop = hooks.Stop.filter(
            (h: unknown) => !isAsdManagedClaudeHook(h)
          );
          if (hooks.Stop.length === 0) delete hooks.Stop;
        }
        if (Object.keys(hooks).length === 0) {
          delete cfg.hooks;
        }
      }

      let preExistingClaudeCfg: Record<string, unknown> | null = null;
      const claudeSettingsBackup = `${claudeSettings}.asd-backup`;
      if (fs.existsSync(claudeSettingsBackup)) {
        try {
          preExistingClaudeCfg = JSON.parse(
            fs.readFileSync(claudeSettingsBackup, "utf8")
          ) as Record<string, unknown>;
        } catch {
          preExistingClaudeCfg = null;
        }
      }
      if (
        (!preExistingClaudeCfg || preExistingClaudeCfg.includeCoAuthoredBy === undefined) &&
        cfg.includeCoAuthoredBy === false
      ) {
        delete cfg.includeCoAuthoredBy;
      }
      if (
        (!preExistingClaudeCfg || preExistingClaudeCfg.attribution === undefined) &&
        cfg.attribution &&
        typeof cfg.attribution === "object" &&
        !Array.isArray(cfg.attribution) &&
        (cfg.attribution as Record<string, unknown>).commit === "" &&
        (cfg.attribution as Record<string, unknown>).pr === "" &&
        Object.keys(cfg.attribution as Record<string, unknown>).length === 2
      ) {
        delete cfg.attribution;
      }

      removeBackupFile(claudeSettings);
      if (Object.keys(cfg).length === 0) {
        removeFile(claudeSettings, "claude-code");
      } else {
        safeWriteJson(claudeSettings, cfg);
        restoredFiles.push(claudeSettings);
        harnessStatus["claude-code"].restored.push(claudeSettings);
      }
    } catch {
      const result = smartRestoreUserBackup(claudeSettings);
      if (result !== "no-backup") {
        restoredFiles.push(claudeSettings);
        harnessStatus["claude-code"].restored.push(claudeSettings);
      } else {
        removeFile(claudeSettings, "claude-code");
      }
    }
  } else {
    removeBackupFile(claudeSettings);
  }

  function cleanupJsonMcpFile(
    filePath: string,
    harness: HarnessId,
    extraDeleteKeys: string[] = []
  ): void {
    if (!fs.existsSync(filePath)) {
      removeBackupFile(filePath);
      return;
    }
    try {
      const rawParsed = parseJsonc(fs.readFileSync(filePath, "utf8"));
      if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) throw new Error("Invalid JSON/JSONC object");
      const parsed = rawParsed as Record<string, unknown>;
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        stripAsdManagedMcpEntries(parsed.mcpServers as Record<string, unknown>);
      }
      for (const k of extraDeleteKeys) {
        delete parsed[k];
      }
      const mcpCount =
        parsed.mcpServers && typeof parsed.mcpServers === "object"
          ? Object.keys(parsed.mcpServers).length
          : 0;
      const otherKeys = Object.keys(parsed).filter((k) => k !== "mcpServers");
      removeBackupFile(filePath);
      if (mcpCount === 0 && otherKeys.length === 0) {
        removeFile(filePath, harness);
      } else {
        safeWriteJson(filePath, parsed);
        restoredFiles.push(filePath);
        harnessStatus[harness].restored.push(filePath);
      }
    } catch {
      const result = smartRestoreUserBackup(filePath);
      if (result !== "no-backup") {
        restoredFiles.push(filePath);
        harnessStatus[harness].restored.push(filePath);
      } else {
        removeFile(filePath, harness);
      }
    }
  }

  cleanupJsonMcpFile(path.join(homeDir, ".claude.json"), "claude-code");
  cleanupJsonMcpFile(path.join(claudeDir, ".mcp.json"), "claude-code");

  // 2. OpenCode
  const opencodeDir = path.join(homeDir, ".config", "opencode");
  for (const skill of ASD_SKILLS) {
    removeFile(path.join(opencodeDir, "command", `${skill}.md`), "opencode");
  }
  removeDirIfEmpty(path.join(opencodeDir, "command"));
  for (const role of AGENT_ROLES) {
    removeFile(path.join(opencodeDir, "agent", `asd-${role}.md`), "opencode");
  }
  removeDirIfEmpty(path.join(opencodeDir, "agent"));
  removeFile(path.join(opencodeDir, "plugin", "asd-guard.js"), "opencode");
  removeDirIfEmpty(path.join(opencodeDir, "plugin"));
  removeFile(path.join(opencodeDir, "AGENTS.md"), "opencode");

  cleanupJsonMcpFile(path.join(opencodeDir, "opencode.json"), "opencode", [
    "_asdVersion",
    "agentRouting",
  ]);
  const opencodeJsoncFile = path.join(opencodeDir, "opencode.jsonc");
  if (fs.existsSync(`${opencodeJsoncFile}.asd-backup`)) {
    const result = smartRestoreUserBackup(opencodeJsoncFile);
    if (result !== "no-backup") {
      restoredFiles.push(opencodeJsoncFile);
      harnessStatus.opencode.restored.push(opencodeJsoncFile);
    }
  }
  const omoConfigFile = path.join(opencodeDir, "oh-my-openagent.json");
  if (fs.existsSync(omoConfigFile)) {
    if (fs.existsSync(`${omoConfigFile}.asd-backup`)) {
      const result = smartRestoreUserBackup(omoConfigFile);
      if (result !== "no-backup") {
        restoredFiles.push(omoConfigFile);
        harnessStatus.opencode.restored.push(omoConfigFile);
      }
    } else {
      try {
        const omoParsed = JSON.parse(fs.readFileSync(omoConfigFile, "utf8")) as Record<string, unknown>;
        if (omoParsed.git_master && typeof omoParsed.git_master === "object" && !Array.isArray(omoParsed.git_master)) {
          const gm = omoParsed.git_master as Record<string, unknown>;
          if (gm.commit_footer === false) delete gm.commit_footer;
          if (gm.include_co_authored_by === false) delete gm.include_co_authored_by;
          if (Object.keys(gm).length === 0) delete omoParsed.git_master;
        }
        if (Object.keys(omoParsed).length === 0) {
          removeFile(omoConfigFile, "opencode");
        } else {
          safeWriteJson(omoConfigFile, omoParsed);
          restoredFiles.push(omoConfigFile);
          harnessStatus.opencode.restored.push(omoConfigFile);
        }
      } catch {
        removeFile(omoConfigFile, "opencode");
      }
    }
  } else {
    removeBackupFile(omoConfigFile);
  }

  // 3. Codex
  const codexDir = path.join(homeDir, ".codex");
  for (const skill of ASD_SKILLS) {
    removeFile(path.join(codexDir, "skills", skill, "SKILL.md"), "codex");
    removeDirIfEmpty(path.join(codexDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(codexDir, "skills"));
  removeFile(path.join(codexDir, "AGENTS.md"), "codex");

  const configToml = path.join(codexDir, "config.toml");
  if (fs.existsSync(configToml)) {
    try {
      const raw = fs.readFileSync(configToml, "utf8");
      const cleaned = removeTomlFence(raw);
      removeBackupFile(configToml);
      if (cleaned.trim() === "") {
        removeFile(configToml, "codex");
      } else {
        safeWriteText(configToml, cleaned);
        restoredFiles.push(configToml);
        harnessStatus.codex.restored.push(configToml);
      }
    } catch {
      const result = smartRestoreUserBackup(configToml);
      if (result !== "no-backup") {
        restoredFiles.push(configToml);
        harnessStatus.codex.restored.push(configToml);
      } else {
        removeFile(configToml, "codex");
      }
    }
  } else {
    removeBackupFile(configToml);
  }

  // 4. Antigravity
  const geminiDir = path.join(homeDir, ".gemini");
  for (const role of AGENT_ROLES) {
    removeFile(path.join(geminiDir, "config", "agents", `asd-${role}.md`), "antigravity");
    removeFile(path.join(geminiDir, "agents", `asd-${role}.md`), "antigravity");
  }
  removeDirIfEmpty(path.join(geminiDir, "config", "agents"));
  removeDirIfEmpty(path.join(geminiDir, "agents"));

  for (const skill of ASD_SKILLS) {
    removeFile(path.join(geminiDir, "skills", skill, "SKILL.md"), "antigravity");
    removeDirIfEmpty(path.join(geminiDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(geminiDir, "skills"));

  const hooksJson = path.join(geminiDir, "hooks.json");
  if (fs.existsSync(hooksJson)) {
    try {
      const hJson = JSON.parse(fs.readFileSync(hooksJson, "utf8")) as Record<string, unknown>;
      if (Array.isArray(hJson.SessionStart)) {
        hJson.SessionStart = hJson.SessionStart.filter(
          (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
        );
        if ((hJson.SessionStart as unknown[]).length === 0) delete hJson.SessionStart;
      }
      if (Array.isArray(hJson.PreToolUse)) {
        hJson.PreToolUse = hJson.PreToolUse.filter(
          (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
        );
        if ((hJson.PreToolUse as unknown[]).length === 0) delete hJson.PreToolUse;
      }
      if (Array.isArray(hJson.Stop)) {
        hJson.Stop = hJson.Stop.filter(
          (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
        );
        if ((hJson.Stop as unknown[]).length === 0) delete hJson.Stop;
      }
      removeBackupFile(hooksJson);
      if (Object.keys(hJson).length === 0) {
        removeFile(hooksJson, "antigravity");
      } else {
        safeWriteJson(hooksJson, hJson);
        restoredFiles.push(hooksJson);
        harnessStatus.antigravity.restored.push(hooksJson);
      }
    } catch {
      const result = smartRestoreUserBackup(hooksJson);
      if (result !== "no-backup") {
        restoredFiles.push(hooksJson);
        harnessStatus.antigravity.restored.push(hooksJson);
      } else {
        removeFile(hooksJson, "antigravity");
      }
    }
  } else {
    removeBackupFile(hooksJson);
  }

  const configHooksJson = path.join(geminiDir, "config", "hooks.json");
  if (fs.existsSync(configHooksJson)) {
    try {
      const chJson = JSON.parse(fs.readFileSync(configHooksJson, "utf8")) as Record<string, unknown>;
      delete chJson["asd-session-tracker"];
      removeBackupFile(configHooksJson);
      if (Object.keys(chJson).length === 0) {
        removeFile(configHooksJson, "antigravity");
      } else {
        safeWriteJson(configHooksJson, chJson);
        restoredFiles.push(configHooksJson);
        harnessStatus.antigravity.restored.push(configHooksJson);
      }
    } catch {
      const result = smartRestoreUserBackup(configHooksJson);
      if (result !== "no-backup") {
        restoredFiles.push(configHooksJson);
        harnessStatus.antigravity.restored.push(configHooksJson);
      } else {
        removeFile(configHooksJson, "antigravity");
      }
    }
  } else {
    removeBackupFile(configHooksJson);
  }

  removeFile(path.join(geminiDir, "config", "asd-hook.mjs"), "antigravity");
  cleanupJsonMcpFile(path.join(geminiDir, "mcp_config.json"), "antigravity");
  cleanupJsonMcpFile(path.join(geminiDir, "config", "mcp_config.json"), "antigravity");
  removeDirIfEmpty(path.join(geminiDir, "config"));

  // 5. Cursor
  const cursorDir = path.join(homeDir, ".cursor");
  for (const role of AGENT_ROLES) {
    removeFile(path.join(cursorDir, "agents", `asd-${role}.md`), "cursor");
  }
  removeDirIfEmpty(path.join(cursorDir, "agents"));
  for (const skill of ASD_SKILLS) {
    removeFile(path.join(cursorDir, "skills", skill, "SKILL.md"), "cursor");
    removeDirIfEmpty(path.join(cursorDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(cursorDir, "skills"));

  const cursorHooksJson = path.join(cursorDir, "hooks.json");
  if (fs.existsSync(cursorHooksJson)) {
    try {
      const hJson = JSON.parse(fs.readFileSync(cursorHooksJson, "utf8")) as Record<string, unknown>;
      for (const legacyKey of ["SessionStart", "PreToolUse", "Stop"] as const) {
        if (Array.isArray(hJson[legacyKey])) {
          hJson[legacyKey] = (hJson[legacyKey] as unknown[]).filter(
            (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
          );
          if ((hJson[legacyKey] as unknown[]).length === 0) delete hJson[legacyKey];
        }
      }
      if (hJson.hooks && typeof hJson.hooks === "object" && !Array.isArray(hJson.hooks)) {
        const nested = hJson.hooks as Record<string, unknown>;
        for (const key of Object.keys(nested)) {
          if (Array.isArray(nested[key])) {
            nested[key] = (nested[key] as unknown[]).filter(
              (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
            );
            if ((nested[key] as unknown[]).length === 0) {
              delete nested[key];
            }
          }
        }
        if (Object.keys(nested).length === 0) {
          delete hJson.hooks;
        }
      }
      if (!hJson.hooks && Object.keys(hJson).every((k) => k === "version")) {
        delete hJson.version;
      }
      removeBackupFile(cursorHooksJson);
      if (Object.keys(hJson).length === 0) {
        removeFile(cursorHooksJson, "cursor");
      } else {
        safeWriteJson(cursorHooksJson, hJson);
        restoredFiles.push(cursorHooksJson);
        harnessStatus.cursor.restored.push(cursorHooksJson);
      }
    } catch {
      const result = smartRestoreUserBackup(cursorHooksJson);
      if (result !== "no-backup") {
        restoredFiles.push(cursorHooksJson);
        harnessStatus.cursor.restored.push(cursorHooksJson);
      } else {
        removeFile(cursorHooksJson, "cursor");
      }
    }
  } else {
    removeBackupFile(cursorHooksJson);
  }

  cleanupJsonMcpFile(path.join(cursorDir, "mcp.json"), "cursor");
  const cursorCliCfg = path.join(cursorDir, "cli-config.json");
  if (fs.existsSync(cursorCliCfg)) {
    try {
      const cJson = JSON.parse(fs.readFileSync(cursorCliCfg, "utf8")) as Record<string, unknown>;
      delete cJson._asdVersion;
      removeBackupFile(cursorCliCfg);
      if (Object.keys(cJson).length === 0) {
        removeFile(cursorCliCfg, "cursor");
      } else {
        safeWriteJson(cursorCliCfg, cJson);
        restoredFiles.push(cursorCliCfg);
        harnessStatus.cursor.restored.push(cursorCliCfg);
      }
    } catch {
      const result = smartRestoreUserBackup(cursorCliCfg);
      if (result !== "no-backup") {
        restoredFiles.push(cursorCliCfg);
        harnessStatus.cursor.restored.push(cursorCliCfg);
      } else {
        removeFile(cursorCliCfg, "cursor");
      }
    }
  } else {
    removeBackupFile(cursorCliCfg);
  }
  removeDirIfEmpty(cursorDir);

  // Remove ASD-managed PATH CLI shims
  removeCliPathShims(homeDir, removedFiles);

  // Remove staged isolated runtime directory inside homeDir/.asd/runtime if present
  const homeRuntimeDir = path.join(homeDir, ".asd", "runtime");
  if (fs.existsSync(homeRuntimeDir)) {
    try {
      fs.rmSync(homeRuntimeDir, { recursive: true, force: true });
      removedFiles.push(homeRuntimeDir);
    } catch {
      // Ignore
    }
  }

  // Remove last-sync.json
  const lastSyncPath = path.join(homeDir, ".asd", "state", "last-sync.json");
  if (fs.existsSync(lastSyncPath)) {
    try {
      fs.unlinkSync(lastSyncPath);
    } catch {
      // Ignore
    }
  }

  return {
    status: "success",
    removedFiles,
    restoredFiles,
    harnesses: harnessStatus,
  };
}

export const runAsdUninstall = uninstallHarnessConfigs;

// ============================================================================
// Doctor Probe: Fast <100ms Zero-Token Diagnostic
// ============================================================================

export async function doctorProbe(
  options?: DoctorProbeOptions
): Promise<DoctorProbeResult> {
  const startTime = performance.now();
  const errors: string[] = [];
  const checks: DoctorCheck[] = [];

  const homeDir = resolveHomeDir(options?.homeDir);
  const projectRoot = options?.projectRoot || process.cwd();

  // 1. Node.js version check (>= 22.13.0)
  const nodeVer = process.versions.node || "0.0.0";
  const [majorStr = "0", minorStr = "0"] = nodeVer.split(".");
  const major = parseInt(majorStr, 10);
  const minor = parseInt(minorStr, 10);
  const nodeOk = major >= 22 && (major > 22 || minor >= 13);

  if (!nodeOk) {
    errors.push(`Node.js version >= 22.13.0 required, current: v${nodeVer}`);
  }
  checks.push({
    name: "node_version",
    ok: nodeOk,
    message: nodeOk ? `Node.js v${nodeVer} (>= 22.13.0)` : `Unsupported Node.js v${nodeVer}`,
  });

  // 2. SQLite WAL health check
  let sqliteOk = false;
  let sqliteMsg = "";
  try {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("PRAGMA journal_mode = WAL;").get() as { journal_mode?: string } | undefined;
    db.close();
    sqliteOk = row?.journal_mode === "wal" || row?.journal_mode === "memory";
    sqliteMsg = "node:sqlite verified with WAL support";
  } catch (err: unknown) {
    sqliteOk = false;
    sqliteMsg = err instanceof Error ? err.message : String(err);
    errors.push(`SQLite verification failed: ${sqliteMsg}`);
  }
  checks.push({
    name: "sqlite_wal",
    ok: sqliteOk,
    message: sqliteMsg,
  });

  // 3. Git repo state
  const isGitRepo = fs.existsSync(path.join(projectRoot, ".git"));
  checks.push({
    name: "git_repo",
    ok: true,
    message: isGitRepo ? `Git repository detected at ${projectRoot}` : `Not a git repository (${projectRoot})`,
  });

  // 4. Harness CLIs & ACP readiness availability
  const probeEnv = options?.env ?? process.env;
  const { acpReadiness, acpBridgeHints, installedClis } = probeAllHarnessesAcp(probeEnv);
  const claudePath = installedClis["claude-code"].resolvedPath;
  const opencodePath = installedClis.opencode.resolvedPath;
  const codexPath = installedClis.codex.resolvedPath;
  const agyPath = installedClis.antigravity.resolvedPath;
  const cursorBin = installedClis.cursor.binary;
  const cursorPath = installedClis.cursor.resolvedPath;
  const harnesses: DoctorProbeResult["harnesses"] = {
    "claude-code": {
      installed: Boolean(claudePath),
      headlessSupported: Boolean(claudePath),
      binary: "claude",
      resolvedPath: claudePath,
      hookCoverage: { preToolUse: "native-hook", stop: "native-hook" },
      acp: acpReadiness["claude-code"],
    },
    opencode: {
      installed: Boolean(opencodePath),
      headlessSupported: Boolean(opencodePath),
      binary: "opencode",
      resolvedPath: opencodePath,
      hookCoverage: { preToolUse: "plugin-hook", stop: "plugin-hook" },
      acp: acpReadiness.opencode,
    },
    codex: {
      installed: Boolean(codexPath),
      headlessSupported: Boolean(codexPath),
      binary: "codex",
      resolvedPath: codexPath,
      hookCoverage: { preToolUse: "sandbox-only", stop: "native-hook" },
      acp: acpReadiness.codex,
    },
    antigravity: {
      installed: Boolean(agyPath),
      headlessSupported: Boolean(agyPath) && Boolean(antigravityAdapter.supportsHeadlessSpawn),
      binary: "agy",
      resolvedPath: agyPath,
      hookCoverage: { preToolUse: "native-hook", stop: "native-hook" },
      acp: acpReadiness.antigravity,
    },
    cursor: {
      installed: Boolean(cursorPath),
      headlessSupported: Boolean(cursorPath) && Boolean(cursorAdapter.supportsHeadlessSpawn),
      binary: cursorBin,
      resolvedPath: cursorPath,
      hookCoverage: { preToolUse: "native-hook", stop: "native-hook" },
      acp: acpReadiness.cursor,
    },
  };
  checks.push({
    name: "harness_clis",
    ok: true,
    message: Object.entries(harnesses)
      .map(([k, v]) => `${k}: ${v.installed ? `installed (${v.resolvedPath})` : "not found"}`)
      .join(", "),
  });
  const acpCheckSegments = DEFAULT_HARNESS_IDS.map((id) => {
    const h = harnesses[id];
    const acp = acpReadiness[id];
    if (!h.installed && !acp.supported) {
      return `${id}: CLI not installed`;
    }
    if (acp.supported) {
      return `${id}: ${acp.mode} ACP ready (${acp.command}${acp.args.length ? ` ${acp.args.join(" ")}` : ""})`;
    }
    return `${id}: missing ${acp.command} -> streaming CLI fallback active`;
  });
  checks.push({
    name: "acp_readiness",
    ok: true,
    message:
      acpCheckSegments.join(", ") +
      (acpBridgeHints.length > 0 ? ` | Hints: ${acpBridgeHints.join(" | ")}` : ""),
  });
  checks.push({
    name: "hook_coverage",
    ok: true,
    message:
      "PreToolUse/Stop coverage: claude-code/antigravity/cursor (native hooks), opencode (plugin/asd-guard.js), codex (notify Stop hook + CLI --sandbox; no native PreToolUse hook)",
  });

  // 5. In-memory synthetic PreToolUse security policy probe (.GIT/config, .ENV)
  const gitEval = evaluatePreToolUse(
    {
      toolName: "Write",
      tool_input: { file_path: ".GIT/config" },
      projectRoot,
    },
    undefined,
    {}
  );
  const envEval = evaluatePreToolUse(
    {
      toolName: "Write",
      tool_input: { file_path: ".ENV" },
      projectRoot,
    },
    undefined,
    {}
  );

  const gitBlocked = !gitEval.allowed;
  const envBlocked = !envEval.allowed;
  const policyOk = gitBlocked && envBlocked;

  if (!policyOk) {
    errors.push(
      `PreToolUse policy probe failed: .GIT/config blocked=${gitBlocked}, .ENV blocked=${envBlocked}`
    );
  }
  checks.push({
    name: "security_policy_probe",
    ok: policyOk,
    message: policyOk
      ? "Zero-token PreToolUse policy probe: .GIT/config and .ENV securely denied"
      : "PreToolUse policy probe violation",
  });

  // 6. Home directory write permission check
  let permOk = true;
  try {
    const testDir = path.join(homeDir, ".asd", "state");
    ensureDir(testDir);
    const testFile = path.join(testDir, `.perm-test-${Date.now()}`);
    fs.writeFileSync(testFile, "ok", "utf8");
    fs.unlinkSync(testFile);
  } catch (err: unknown) {
    permOk = false;
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Home directory permission test failed: ${msg}`);
  }
  checks.push({
    name: "home_permissions",
    ok: permOk,
    message: permOk ? `Permissions verified for ${homeDir}/.asd` : "Permission denied",
  });

  const durationMs = performance.now() - startTime;

  return {
    ok: errors.length === 0,
    durationMs,
    checks,
    nodeVersion: {
      ok: nodeOk,
      version: nodeVer,
      minRequired: ">=22.13.0",
    },
    sqliteWal: {
      ok: sqliteOk,
      message: sqliteMsg,
    },
    gitRepo: {
      ok: true,
      isRepo: isGitRepo,
      message: isGitRepo ? "Git repository confirmed" : "Non-git directory",
    },
    harnesses,
    ...(acpBridgeHints.length > 0 ? { acpBridgeHints } : {}),
    policyProbe: {
      ok: policyOk,
      gitBlocked,
      envBlocked,
      message: policyOk ? "Both .GIT/config and .ENV denied" : "Policy probe failure",
    },
    errors,
  };
}

export const runAsdDoctor = doctorProbe;

registerCoreInstallerHooks({
  runAsdDoctor,
  syncAgentModelsIfNeeded,
});

// ============================================================================
// Self-Updater: runAsdUpdate (`asd update`)
// ============================================================================

export interface AsdUpdateResult {
  updated: boolean;
  aborted?: boolean;
  previousVersion: string;
  latestVersion: string;
  message: string;
}

export async function runAsdUpdate(options?: {
  homeDir?: string;
  projectRoot?: string;
  remoteUrl?: string;
  asdRootOverride?: string;
}): Promise<AsdUpdateResult> {
  const asdRoot = options?.asdRootOverride
    ? path.resolve(options.asdRootOverride)
    : getAsdRoot();
  const homeDir = resolveHomeDir(options?.homeDir);
  const previousVersion = ASD_VERSION;

  const check = await checkForRemoteUpdate({
    homeDir,
    force: true,
    timeoutMs: 5000,
    remoteUrl: options?.remoteUrl,
  });

  // Check for uncommitted tracked modifications in asdRoot
  const statusRes = child_process.spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: asdRoot, encoding: "utf8", windowsHide: true }
  );
  if (statusRes.status === 0 && (statusRes.stdout || "").trim().length > 0) {
    return {
      updated: false,
      aborted: true,
      previousVersion,
      latestVersion: check.latestVersion ?? previousVersion,
      message: `Update aborted: Uncommitted local changes detected in ${asdRoot}. Please commit or stash them first.`,
    };
  }

  if (
    check.latestVersion &&
    compareSemver(previousVersion, check.latestVersion) >= 0
  ) {
    return {
      updated: false,
      previousVersion,
      latestVersion: check.latestVersion,
      message: `ASD is already up to date (v${previousVersion}).`,
    };
  }

  const pullRes = child_process.spawnSync("git", ["pull", "--ff-only"], {
    cwd: asdRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (pullRes.status !== 0) {
    const errText = (pullRes.stderr || pullRes.stdout || "git pull failed").trim();
    throw new Error(`Failed to pull latest changes in ${asdRoot}: ${errText}`);
  }

  // Read newly pulled package.json version
  let newVersion = check.latestVersion ?? previousVersion;
  try {
    const pkgRaw = fs.readFileSync(path.join(asdRoot, "package.json"), "utf8");
    const parsedPkg = JSON.parse(pkgRaw) as { version?: string };
    if (parsedPkg.version?.trim()) {
      newVersion = parsedPkg.version.trim();
    }
  } catch {
    // fallback
  }

  // Update cached version file so the update banner clears immediately
  try {
    const cachePath = path.join(homeDir, ".asd", "state", "update-check.json");
    ensureDir(path.dirname(cachePath));
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ latestVersion: newVersion, checkedAt: Date.now() }, null, 2) + "\n",
      "utf8"
    );
  } catch {
    // ignore
  }

  // Run sync in a fresh Node process so the newly pulled code & version are loaded
  const cliScript = path.join(asdRoot, "src", "cli", "index.ts");
  if (fs.existsSync(cliScript)) {
    const syncArgs = ["--no-warnings", cliScript, "sync", "--force"];
    if (options?.homeDir) {
      syncArgs.push("--home", options.homeDir);
    }
    child_process.spawnSync(process.execPath, syncArgs, {
      cwd: asdRoot,
      encoding: "utf8",
      windowsHide: true,
    });
  } else {
    await syncHarnessConfigs({ homeDir, force: true, projectRoot: options?.projectRoot });
  }

  if (newVersion === previousVersion && (pullRes.stdout || "").includes("Already up to date")) {
    return {
      updated: false,
      previousVersion,
      latestVersion: newVersion,
      message: `ASD is already up to date (v${newVersion}).`,
    };
  }

  return {
    updated: true,
    previousVersion,
    latestVersion: newVersion,
    message: `ASD successfully updated from v${previousVersion} to v${newVersion}!`,
  };
}
