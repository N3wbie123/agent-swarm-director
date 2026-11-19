/**
 * ASD v2.7.0 External Catalog MCP Sync (src/adapters/installer/mcp-sync.ts)
 *
 * Manages capability-aware, deduplicated external catalog MCP server synchronization
 * (e.g. context7, grep_app, websearch from `presets/default-mcp.jsonc` / `~/.asd/mcp.jsonc`)
 * across all 5 harnesses while stripping any retired legacy `asd-core` MCP entries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { compareSemver } from "../../core/config.ts";
import { escapeTomlBasicString, parseJsonc } from "../../core/jsonc.ts";
import { ASD_VERSION, type HarnessId } from "../../core/types.ts";

export interface CatalogMcpEntry {
  command?: string;
  args?: string[];
  url?: string;
}

function getAsdRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..", "..");
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
  if (
    liveContent !== backupContent &&
    (asdManagedContent === undefined || liveContent !== asdManagedContent)
  ) {
    fs.copyFileSync(filePath, backupPath);
  }
}

/**
 * Ensures `~/.asd/mcp.jsonc` exists and upgrades its `_asdVersion` stamp when older than `ASD_VERSION`.
 */
export function bootstrapGlobalMcpPreset(homeDir: string, asdRoot: string = getAsdRoot()): string {
  const asdHome = path.join(homeDir, ".asd");
  ensureDir(asdHome);
  const mcpPath = path.join(asdHome, "mcp.jsonc");
  const presetMcp = path.join(asdRoot, "presets", "default-mcp.jsonc");

  if (!fs.existsSync(mcpPath)) {
    if (fs.existsSync(presetMcp)) {
      const content = fs
        .readFileSync(presetMcp, "utf8")
        .replace(/\bASD v\d+\.\d+(?:\.\d+)?\b/g, `ASD v${ASD_VERSION}`)
        .replace(/"_asdVersion":\s*"[^"]*"/g, `"_asdVersion": "${ASD_VERSION}"`);
      safeWriteText(mcpPath, content);
    } else {
      safeWriteText(mcpPath, `// ASD Default MCP\n{\n  "_asdVersion": "${ASD_VERSION}"\n}\n`);
    }
  } else {
    try {
      const existingMcp = fs.readFileSync(mcpPath, "utf8");
      const parsedMcp = parseJsonc<{ _asdVersion?: string }>(existingMcp);
      if (
        parsedMcp &&
        typeof parsedMcp._asdVersion === "string" &&
        compareSemver(parsedMcp._asdVersion, ASD_VERSION) < 0
      ) {
        const updatedMcp = existingMcp
          .replace(/\bASD v\d+\.\d+(?:\.\d+)?\b/g, `ASD v${ASD_VERSION}`)
          .replace(/"_asdVersion":\s*"[^"]*"/g, `"_asdVersion": "${ASD_VERSION}"`);
        if (updatedMcp !== existingMcp) {
          safeWriteText(mcpPath, updatedMcp);
        }
      }
    } catch {
      // Ignore unparseable user mcp.jsonc
    }
  }

  return mcpPath;
}

export function loadHarnessNativeCapabilities(): Record<HarnessId, Set<string>> {
  return {
    "claude-code": new Set(["websearch"]),
    opencode: new Set(["lsp"]),
    codex: new Set(["websearch"]),
    antigravity: new Set(["websearch"]),
    cursor: new Set(["websearch"]),
  };
}

export function loadCatalogMcpServers(
  homeDir: string,
  asdRoot: string
): Record<string, CatalogMcpEntry> {
  const mcpPath = bootstrapGlobalMcpPreset(homeDir, asdRoot);
  const presetMcpPath = path.join(asdRoot, "presets", "default-mcp.jsonc");

  let presetServers: Record<string, CatalogMcpEntry> = {};
  try {
    if (fs.existsSync(presetMcpPath)) {
      const parsed = parseJsonc<{ mcpServers?: Record<string, CatalogMcpEntry> }>(
        fs.readFileSync(presetMcpPath, "utf8")
      );
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        presetServers = { ...parsed.mcpServers };
      }
    }
  } catch {
    presetServers = {};
  }

  let userCatalogServers: Record<string, CatalogMcpEntry> = {};
  try {
    if (fs.existsSync(mcpPath)) {
      const parsed = parseJsonc<{ mcpServers?: Record<string, CatalogMcpEntry> }>(
        fs.readFileSync(mcpPath, "utf8")
      );
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        userCatalogServers = { ...parsed.mcpServers };
      }
    }
  } catch {
    userCatalogServers = {};
  }

  const merged: Record<string, CatalogMcpEntry> = {
    ...presetServers,
    ...userCatalogServers,
  };

  // Resolve <ASD_ROOT> placeholder in args (excluding retired asd-core MCP)
  const resolved: Record<string, CatalogMcpEntry> = {};
  for (const [name, entry] of Object.entries(merged)) {
    if (name === "asd-core" || !entry || typeof entry !== "object") continue;
    if (entry.command) {
      const args = Array.isArray(entry.args)
        ? entry.args.map((arg) =>
            arg.includes("<ASD_ROOT>")
              ? path.normalize(arg.replace("<ASD_ROOT>", asdRoot))
              : arg
          )
        : [];
      resolved[name] = { command: entry.command, args };
    } else if (entry.url) {
      resolved[name] = { url: entry.url };
    }
  }

  return resolved;
}

export function mergeJsonMcpServersForHarness(options: {
  harnessId: "claude-code" | "opencode" | "antigravity" | "cursor";
  existingMcpServers: Record<string, unknown>;
  catalog: Record<string, CatalogMcpEntry>;
  nativeCapabilities: Set<string>;
  externalExistingKeys?: Set<string>;
}): Record<string, unknown> {
  const {
    harnessId,
    existingMcpServers,
    catalog,
    nativeCapabilities,
    externalExistingKeys,
  } = options;

  // Keep only non-ASD-managed user entries first (and strip any legacy asd-core)
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existingMcpServers)) {
    if (k === "asd-core") continue;
    const isManaged =
      v !== null &&
      typeof v === "object" &&
      (v as Record<string, unknown>)._asdManaged === true;
    if (!isManaged) {
      result[k] = v;
    }
  }

  for (const [serverName, def] of Object.entries(catalog)) {
    if (serverName === "asd-core") continue;
    const lowerName = serverName.toLowerCase();

    // 1. Native capability filter: skip if harness already has this feature built-in
    if (nativeCapabilities.has(lowerName)) {
      continue;
    }
    // 2. Existing user/plugin config dedup filter: skip if already defined by user
    if (Object.prototype.hasOwnProperty.call(result, serverName)) {
      continue;
    }
    // 3. External existing keys filter: skip if key exists in externalExistingKeys
    // (externalExistingKeys is pre-filtered in syncJsonMcpConfigFile to only contain
    // keys from other user config files or keys that exist in the current config)
    if (externalExistingKeys?.has(serverName) || externalExistingKeys?.has(lowerName)) {
      continue;
    }

    if (def.command) {
      result[serverName] = {
        command: def.command,
        args: def.args ?? [],
        _asdManaged: true,
      };
    } else if (def.url) {
      if (harnessId === "claude-code") {
        result[serverName] = {
          type: "http",
          url: def.url,
          _asdManaged: true,
        };
      } else if (harnessId === "antigravity") {
        result[serverName] = {
          serverUrl: def.url,
          _asdManaged: true,
        };
      } else {
        result[serverName] = {
          url: def.url,
          _asdManaged: true,
        };
      }
    }
  }

  return result;
}

export function syncJsonMcpConfigFile(options: {
  filePath: string;
  harnessId: "claude-code" | "opencode" | "antigravity" | "cursor";
  catalog: Record<string, CatalogMcpEntry>;
  nativeCapabilities: Set<string>;
  externalExistingKeys?: Set<string>;
  mutateBeforeMerge?: (config: Record<string, unknown>, extKeys: Set<string>) => void;
}): void {
  const { filePath, harnessId, catalog, nativeCapabilities, externalExistingKeys, mutateBeforeMerge } = options;
  let config: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    backupUserFile(filePath);
    try {
      const parsed = parseJsonc(fs.readFileSync(filePath, "utf8"));
      config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      config = {};
    }
  }
  const extKeys = new Set<string>(externalExistingKeys);
  mutateBeforeMerge?.(config, extKeys);
  // Filter extKeys: only keep keys that were in original externalExistingKeys
  // or actually exist in the user's current config (mcpServers).
  // This prevents mutateBeforeMerge from adding phantom keys (e.g., from cfg.mcp)
  // that would incorrectly suppress ASD-managed server injection.
  const currentMcpKeys = new Set<string>();
  const existingMcp =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  for (const k of Object.keys(existingMcp)) {
    currentMcpKeys.add(k);
    currentMcpKeys.add(k.toLowerCase());
  }
  const originalExtKeys = new Set<string>(externalExistingKeys);
  for (const k of extKeys) {
    if (!originalExtKeys.has(k) && !currentMcpKeys.has(k)) {
      extKeys.delete(k);
    }
  }
  config.mcpServers = mergeJsonMcpServersForHarness({
    harnessId,
    existingMcpServers: existingMcp,
    catalog,
    nativeCapabilities,
    externalExistingKeys: extKeys,
  });
  safeWriteJson(filePath, config);
}

export function buildCodexManagedTomlBlock(options: {
  unmanagedToml: string;
  catalog: Record<string, CatalogMcpEntry>;
  nativeCapabilities: Set<string>;
  asdCliPath?: string;
}): string {
  const { unmanagedToml, catalog, nativeCapabilities } = options;
  const resolvedCliPath = escapeTomlBasicString(
    (options.asdCliPath || path.join(getAsdRoot(), "src", "cli", "index.ts")).replaceAll("\\", "/")
  );

  // Detect any [mcp_servers.<name>] already defined outside ASD fence
  const existingKeys = new Set<string>();
  const sectionRegex = /^\s*\[mcp_servers\.([^\].\s]+)\]/gm;
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(unmanagedToml)) !== null) {
    if (match[1]) {
      existingKeys.add(match[1].replace(/^["']|["']$/g, ""));
    }
  }

  const blocks: string[] = [];

  // Codex notify hook: receives turn-complete JSON payload as final argv (and/or stdin)
  // Check only the root-scope portion of unmanagedToml (before the first [table] header)
  const firstTableMatch = /^\s*\[{1,2}[^\]\r\n]+\]{1,2}\s*(?:#.*)?$/m.exec(unmanagedToml);
  const rootScopeToml =
    firstTableMatch && firstTableMatch.index !== undefined
      ? unmanagedToml.slice(0, firstTableMatch.index)
      : unmanagedToml;
  const hasUnmanagedNotify = /^\s*notify\s*=/m.test(rootScopeToml);
  if (!hasUnmanagedNotify) {
    blocks.push(
      `notify = ["node", "--no-warnings", "${resolvedCliPath}", "hook", "stop", "--harness", "codex"]`
    );
  }

  for (const [serverName, def] of Object.entries(catalog)) {
    if (serverName === "asd-core") continue;
    const lowerName = serverName.toLowerCase();
    if (nativeCapabilities.has(lowerName)) continue;
    if (existingKeys.has(serverName) || existingKeys.has(lowerName)) continue;

    if (def.command) {
      const escapedCommand = escapeTomlBasicString(def.command.replaceAll("\\", "/"));
      const normalizedArgs = (def.args ?? []).map((a) =>
        `"${escapeTomlBasicString(a.replaceAll("\\", "/"))}"`
      );
      blocks.push(
        `[mcp_servers.${serverName}]\ncommand = "${escapedCommand}"\nargs = [${normalizedArgs.join(", ")}]`
      );
    } else if (def.url) {
      blocks.push(`[mcp_servers.${serverName}]\nurl = "${escapeTomlBasicString(def.url)}"`);
    }
  }

  return blocks.join("\n\n") + "\n";
}

export function stripAsdManagedMcpEntries(mcpObj: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(mcpObj)) {
    const isManaged =
      key === "asd-core" ||
      (val !== null &&
        typeof val === "object" &&
        (val as Record<string, unknown>)._asdManaged === true);
    if (isManaged) {
      delete mcpObj[key];
    }
  }
}
