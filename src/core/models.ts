/**
 * ASD Model Discovery & Cache (src/core/models.ts)
 *
 * Pure data service for discovering available models per harness and managing
 * the disk cache (~/.asd/state/models-cache.json). No UI/server dependencies.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFileSync } from "./render.ts";
import { inferModelFamily } from "./router.ts";
import {
  resolveSpawnCommand,
  type CommandRunner,
} from "./spawner.ts";
import type { HarnessId } from "./types.ts";

export type HarnessModelCatalog = Record<HarnessId, string[]>;

const DEFAULT_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

const modelCatalogCache = new Map<string, HarnessModelCatalog>();

export function detectSystemLocale(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // Ignore
  }
  return process.env.LC_ALL || process.env.LANG || "en-US";
}

export function getModelsDiskCachePath(homeDir: string): string {
  return path.join(path.resolve(homeDir), ".asd", "state", "models-cache.json");
}

function readModelsDiskCache(
  homeDir: string,
  ttlMs = DEFAULT_MODELS_CACHE_TTL_MS
): HarnessModelCatalog | null {
  try {
    const cachePath = getModelsDiskCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      updatedAt?: number;
      catalog?: HarnessModelCatalog;
    };
    if (
      !raw ||
      typeof raw.updatedAt !== "number" ||
      Date.now() - raw.updatedAt > ttlMs ||
      !raw.catalog ||
      typeof raw.catalog !== "object"
    ) {
      return null;
    }
    return raw.catalog;
  } catch {
    return null;
  }
}

export function writeModelsDiskCache(
  homeDir: string,
  catalog: HarnessModelCatalog,
  forceCreateDir = false
): void {
  try {
    const resolvedHome = path.resolve(homeDir);
    const asdDir = path.join(resolvedHome, ".asd");
    if (!forceCreateDir && !fs.existsSync(asdDir)) return;
    const cachePath = getModelsDiskCachePath(resolvedHome);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    atomicWriteFileSync(
      cachePath,
      JSON.stringify({ updatedAt: Date.now(), catalog }, null, 2) + "\n"
    );
  } catch {
    // Ignore disk cache write errors
  }
}

function execCliOutputAsync(
  command: string,
  args: string[],
  timeoutMs = 3500,
  cwd?: string
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout });
    };

    try {
      const resolved = resolveSpawnCommand(command, args);
      const child = child_process.spawn(resolved.command, resolved.args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: resolved.shell,
        ...(cwd ? { cwd } : {}),
      });

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish(null);
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length < 256 * 1024) {
          stdout += chunk.toString();
        }
      });

      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Dynamically discovers ALL real available models for Antigravity, Claude Code, Codex, and OpenCode
 * by querying each harness's live CLI (`agy models`, `opencode models`), local model caches
 * (`~/.codex/models_cache.json`, `~/.claude/settings.json`, `~/.claude/litellm_config.yaml`),
 * and any configured remote OpenAI-compatible gateway (`integrate.api.nvidia.com/v1/models`, etc.).
 * Uses an in-memory + disk cache (`~/.asd/state/models-cache.json`) and parallel async probes
 * so `asd ui` startup never blocks on synchronous CLI spawns.
 */
export async function discoverHarnessModels(options?: {
  projectRoot?: string;
  homeDir?: string;
  forceRefresh?: boolean;
  skipCliSpawn?: boolean;
  enableGatewayProbe?: boolean | "trusted-only";
  cacheTtlMs?: number;
  persistCache?: boolean;
  cliTimeoutMs?: number;
  excludeAsdRouting?: boolean;
}): Promise<HarnessModelCatalog> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = path.resolve(options?.homeDir || os.homedir());
  const cacheKey = `${projectRoot}::${homeDir}::${options?.excludeAsdRouting ? "noasd" : "all"}`;
  const ttlMs = options?.cacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
  const cliTimeoutMs = options?.cliTimeoutMs ?? 3500;
  const excludeAsdRouting = Boolean(options?.excludeAsdRouting);

  if (!options?.forceRefresh && !excludeAsdRouting) {
    if (modelCatalogCache.has(cacheKey)) {
      return modelCatalogCache.get(cacheKey)!;
    }
    const diskCached = readModelsDiskCache(homeDir, ttlMs);
    if (diskCached) {
      modelCatalogCache.set(cacheKey, diskCached);
      return diskCached;
    }
  }

  const sets: Record<HarnessId, Set<string>> = {
    antigravity: new Set<string>(),
    "claude-code": new Set<string>(),
    codex: new Set<string>(),
    opencode: new Set<string>(),
    cursor: new Set<string>(),
  };

  // 1. Antigravity: local `~/.gemini/antigravity-cli/settings.json`
  try {
    const agySettingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    if (fs.existsSync(agySettingsPath)) {
      const agySettings = JSON.parse(fs.readFileSync(agySettingsPath, "utf8")) as {
        model?: string;
      };
      if (typeof agySettings.model === "string") {
        const trimmed = agySettings.model.trim();
        if (trimmed && !trimmed.includes(" ")) {
          sets.antigravity.add(trimmed);
        }
      }
    }
  } catch {
    // Ignore antigravity settings scan errors
  }

  // 2. Codex: scan `~/.codex/models_cache.json` and `~/.codex/config.toml`
  try {
    const codexCachePath = path.join(homeDir, ".codex", "models_cache.json");
    if (fs.existsSync(codexCachePath)) {
      const cacheObj = JSON.parse(fs.readFileSync(codexCachePath, "utf8")) as {
        models?: Array<{ slug?: string; visibility?: string }>;
      };
      if (Array.isArray(cacheObj.models)) {
        for (const item of cacheObj.models) {
          if (item?.visibility === "hide") continue;
          if (item?.slug && typeof item.slug === "string" && item.slug.trim()) {
            sets.codex.add(item.slug.trim());
          }
        }
      }
    }
    const codexTomlPath = path.join(homeDir, ".codex", "config.toml");
    if (fs.existsSync(codexTomlPath)) {
      const tomlText = fs.readFileSync(codexTomlPath, "utf8");
      const matches = tomlText.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm);
      for (const m of matches) {
        if (m[1]?.trim()) sets.codex.add(m[1].trim());
      }
    }
  } catch {
    // Ignore codex scan errors
  }

  // 3. Claude Code: scan `~/.claude/settings.json` and `~/.claude/litellm_config.yaml`
  let anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim() || "";
  let anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || "";
  let nvidiaToken = process.env.NVIDIA_NIM_API_KEY?.trim() || "";
  let litellmBaseUrl = "";
  try {
    const addClaudeModel = (raw: string | undefined) => {
      if (!raw || typeof raw !== "string") return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      sets["claude-code"].add(trimmed);
      const stripped = trimmed.replace(/\[.*\]$/, "").trim();
      if (stripped) sets["claude-code"].add(stripped);
    };

    addClaudeModel(process.env.ANTHROPIC_MODEL);
    addClaudeModel(process.env.ANTHROPIC_CUSTOM_MODEL_OPTION);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL);

    const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const settingsObj = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as {
        model?: string;
        env?: Record<string, string>;
      };
      addClaudeModel(settingsObj.model);
      const env = settingsObj.env ?? {};
      addClaudeModel(env.ANTHROPIC_MODEL);
      addClaudeModel(env.ANTHROPIC_CUSTOM_MODEL_OPTION);
      addClaudeModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
      addClaudeModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
      addClaudeModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
      if (env.ANTHROPIC_AUTH_TOKEN?.trim()) {
        anthropicToken = env.ANTHROPIC_AUTH_TOKEN.trim();
      }
      if (env.ANTHROPIC_BASE_URL?.trim()) {
        anthropicBaseUrl = env.ANTHROPIC_BASE_URL.trim();
      }
      if (env.NVIDIA_NIM_API_KEY?.trim()) {
        nvidiaToken = env.NVIDIA_NIM_API_KEY.trim();
      }
    }

    const litellmYamlPath = path.join(homeDir, ".claude", "litellm_config.yaml");
    if (fs.existsSync(litellmYamlPath)) {
      const yamlText = fs.readFileSync(litellmYamlPath, "utf8");
      const defMatch = yamlText.match(/default_model:\s*["']?([^"'\r\n#]+)["']?/);
      if (defMatch?.[1]) addClaudeModel(defMatch[1]);
      const baseMatch = yamlText.match(/api_base:\s*["']?([^"'\r\n#]+)["']?/);
      if (baseMatch?.[1]?.trim()) {
        litellmBaseUrl = baseMatch[1].trim().replace(/\/+$/, "");
      }
      for (const m of yamlText.matchAll(/-\s*model_name:\s*["']?([^"'\r\n#]+)["']?/g)) {
        if (m[1]) addClaudeModel(m[1]);
      }
      for (const m of yamlText.matchAll(/model:\s*["']?([^"'\r\n#]+)["']?/g)) {
        if (m[1]) addClaudeModel(m[1].trim().replace(/^nvidia_nim\//, ""));
      }
    }
  } catch {
    // Ignore claude local scan errors
  }

  // 4. OpenCode: scan opencode.json, opencode.jsonc, agent/*.md, and ~/.asd/routing.jsonc
  try {
    const parseOpencodeConfig = (cfgText: string) => {
      try {
        const cleaned = cfgText.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, "");
        const ocObj = JSON.parse(cleaned) as {
          model?: string;
          small_model?: string;
          provider?: Record<string, { models?: Record<string, unknown> }>;
        };
        if (typeof ocObj.model === "string" && ocObj.model.trim()) {
          sets.opencode.add(ocObj.model.trim());
        }
        if (typeof ocObj.small_model === "string" && ocObj.small_model.trim()) {
          sets.opencode.add(ocObj.small_model.trim());
        }
        if (ocObj.provider && typeof ocObj.provider === "object") {
          for (const [provKey, provVal] of Object.entries(ocObj.provider)) {
            if (provVal?.models && typeof provVal.models === "object") {
              for (const mKey of Object.keys(provVal.models)) {
                sets.opencode.add(`${provKey}/${mKey}`);
              }
            }
          }
        }
      } catch {
        // ignore parse error
      }
    };

    const ocJsonPath = path.join(homeDir, ".config", "opencode", "opencode.json");
    if (fs.existsSync(ocJsonPath)) {
      parseOpencodeConfig(fs.readFileSync(ocJsonPath, "utf8"));
    }

    const ocJsoncPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
    if (fs.existsSync(ocJsoncPath)) {
      parseOpencodeConfig(fs.readFileSync(ocJsoncPath, "utf8"));
    }

    // Scan ~/.config/opencode/agent/*.md frontmatter for configured models
    const agentDir = path.join(homeDir, ".config", "opencode", "agent");
    if (fs.existsSync(agentDir)) {
      for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
        if (excludeAsdRouting && entry.name.startsWith("asd-")) continue;
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const text = fs.readFileSync(path.join(agentDir, entry.name), "utf8");
            const m = /^model:\s*["']?([^"'\r\n#]+)["']?/m.exec(text);
            if (m?.[1]?.trim()) {
              sets.opencode.add(m[1].trim());
            }
          } catch {
            // ignore agent read error
          }
        }
      }
    }

    // Scan global ~/.asd/routing.jsonc for opencode models (UI dropdown convenience only)
    const globalRoutingPath = path.join(homeDir, ".asd", "routing.jsonc");
    if (!excludeAsdRouting && fs.existsSync(globalRoutingPath)) {
      try {
        const text = fs.readFileSync(globalRoutingPath, "utf8");
        const matches = text.matchAll(/"harness"\s*:\s*"opencode"\s*,\s*"model"\s*:\s*"([^"]+)"/g);
        for (const match of matches) {
          if (match[1]?.trim()) {
            sets.opencode.add(match[1].trim());
          }
        }
      } catch {
        // ignore routing read error
      }
    }
  } catch {
    // Ignore opencode scan errors
  }

  // 5. Cursor: scan ~/.cursor/cli-config.json, ~/.cursor/agents/*.md, and ~/.asd/routing.jsonc
  try {
    const cursorCfgPath = path.join(homeDir, ".cursor", "cli-config.json");
    if (fs.existsSync(cursorCfgPath)) {
      const cObj = JSON.parse(fs.readFileSync(cursorCfgPath, "utf8")) as { model?: { modelId?: string } | string };
      if (typeof cObj.model === "string" && cObj.model.trim()) {
        sets.cursor.add(cObj.model.trim());
      } else if (cObj.model && typeof cObj.model === "object" && typeof cObj.model.modelId === "string" && cObj.model.modelId.trim()) {
        sets.cursor.add(cObj.model.modelId.trim());
      }
    }

    const cursorAgentDir = path.join(homeDir, ".cursor", "agents");
    if (fs.existsSync(cursorAgentDir)) {
      for (const entry of fs.readdirSync(cursorAgentDir, { withFileTypes: true })) {
        if (excludeAsdRouting && entry.name.startsWith("asd-")) continue;
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const text = fs.readFileSync(path.join(cursorAgentDir, entry.name), "utf8");
            const m = /^model:\s*["']?([^"'\r\n#]+)["']?/m.exec(text);
            if (m?.[1]?.trim()) {
              sets.cursor.add(m[1].trim());
            }
          } catch {
            // ignore
          }
        }
      }
    }

    const globalRoutingPath = path.join(homeDir, ".asd", "routing.jsonc");
    if (!excludeAsdRouting && fs.existsSync(globalRoutingPath)) {
      try {
        const text = fs.readFileSync(globalRoutingPath, "utf8");
        const matches = text.matchAll(/"harness"\s*:\s*"cursor"\s*,\s*"model"\s*:\s*"([^"]+)"/g);
        for (const match of matches) {
          if (match[1]?.trim()) {
            sets.cursor.add(match[1].trim());
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // Ignore cursor scan errors
  }

  // 6. Parallel non-blocking CLI & remote gateway probes
  const runCliProbes = !options?.skipCliSpawn;
  const runGatewayProbe = !options?.skipCliSpawn || Boolean(options?.enableGatewayProbe);
  if (runCliProbes || runGatewayProbe) {
    const agyProbe = !runCliProbes ? Promise.resolve() : execCliOutputAsync("agy", ["models"], cliTimeoutMs).then((res) => {
      if (!res.stdout) return;
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("Fetching")) continue;
        const firstCol = line.split("\t")[0]?.trim();
        if (firstCol && !firstCol.includes(" ")) {
          sets.antigravity.add(firstCol);
        }
      }
    });

    const opencodeProbe = !runCliProbes ? Promise.resolve() : execCliOutputAsync("opencode", ["models"], cliTimeoutMs, homeDir).then((res) => {
      if (res.status !== 0 || !res.stdout) return;
      const lines = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("[") && !l.includes(" "));
      for (const line of lines) {
        sets.opencode.add(line);
      }
    });

    const parseCursorModelsOutput = (stdout: string) => {
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("Available models") || line.startsWith("Tip:")) continue;
        const modelId = line.split(" - ")[0]?.trim();
        if (modelId && !modelId.includes(" ")) {
          sets.cursor.add(modelId);
        }
      }
    };

    const cursorProbe = !runCliProbes ? Promise.resolve() : execCliOutputAsync("cursor-agent", ["models"], cliTimeoutMs).then((res) => {
      if (res.stdout) {
        parseCursorModelsOutput(res.stdout);
      } else {
        return execCliOutputAsync("agent", ["models"], cliTimeoutMs).then((agentRes) => {
          if (agentRes.stdout) parseCursorModelsOutput(agentRes.stdout);
        });
      }
    });

    // Pair each token strictly with its matching gateway base URL (F21)
    const TRUSTED_GATEWAY_HOSTS = new Set([
      "api.anthropic.com",
      "integrate.api.nvidia.com",
      "api.openai.com",
    ]);
    const isSafeGatewayProbeUrl = (rawUrl: string, allowCustomRemoteHost: boolean): boolean => {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.username || parsed.password) return false;
        const host = parsed.hostname.toLowerCase();
        const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
        if (isLoopback) {
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        }
        if (parsed.protocol !== "https:") return false;
        if (
          host === "0.0.0.0" ||
          host === "metadata.google.internal" ||
          host === "100.100.100.200" ||
          host.startsWith("169.254.") ||
          host.startsWith("10.") ||
          host.startsWith("192.168.") ||
          /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
        ) {
          return false;
        }
        if (TRUSTED_GATEWAY_HOSTS.has(host)) return true;
        return allowCustomRemoteHost;
      } catch {
        return false;
      }
    };

    const allowCustomRemoteHost =
      options?.enableGatewayProbe === true ||
      process.env.ASD_ALLOW_CUSTOM_GATEWAY_PROBE === "1";

    let gatewayToken = "";
    let gatewayBase = "";
    const explicitGatewayBase = (anthropicBaseUrl || litellmBaseUrl).replace(/\/+$/, "");
    if (anthropicToken && explicitGatewayBase) {
      if (isSafeGatewayProbeUrl(explicitGatewayBase, allowCustomRemoteHost)) {
        gatewayToken = anthropicToken;
        gatewayBase = explicitGatewayBase;
      }
    } else if (nvidiaToken) {
      const candidateNvidiaBase = "https://integrate.api.nvidia.com/v1";
      if (
        !explicitGatewayBase ||
        explicitGatewayBase.toLowerCase().includes("integrate.api.nvidia.com")
      ) {
        gatewayToken = nvidiaToken;
        gatewayBase = explicitGatewayBase || candidateNvidiaBase;
      }
    }

    const gatewayProbe = (async () => {
      if (
        !gatewayToken ||
        !gatewayBase ||
        gatewayToken.includes("dummy") ||
        gatewayToken.includes("\uC5EC\uAE30\uC5D0_")
      ) {
        return;
      }
      try {
        const modelsEndpoint = gatewayBase.endsWith("/models") ? gatewayBase : `${gatewayBase}/models`;
        const res = await fetch(modelsEndpoint, {
          headers: { Authorization: `Bearer ${gatewayToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id?: string }> };
          if (Array.isArray(data.data)) {
            for (const item of data.data) {
              if (item?.id && typeof item.id === "string" && item.id.trim()) {
                sets["claude-code"].add(item.id.trim());
              }
            }
          }
        }
      } catch {
        // Ignore remote gateway timeout/network error
      }
    })();

    await Promise.all([agyProbe, opencodeProbe, cursorProbe, gatewayProbe]);
  }

  const catalog: HarnessModelCatalog = {
    antigravity: [...sets.antigravity],
    "claude-code": [...sets["claude-code"]],
    codex: [...sets.codex],
    opencode: [...sets.opencode],
    cursor: [...sets.cursor],
  };

  modelCatalogCache.set(cacheKey, catalog);
  writeModelsDiskCache(homeDir, catalog, Boolean(options?.persistCache));
  return catalog;
}

// ============================================================================
// Routing Model Validation & Initial-Bootstrap / Explicit-Refresh Substitution
// ============================================================================

export interface RoutingModelWarning {
  location: string;
  harness: HarnessId;
  configuredModel: string;
  suggestedModel: string;
}

export interface RoutingModelRemap {
  location: string;
  harness: HarnessId;
  fromModel: string;
  toModel: string;
}

const ANTIGRAVITY_NATIVE_TIERS = new Set(["inherit", "flash_lite", "flash", "pro"]);
const CLAUDE_NATIVE_ALIASES = new Set(["haiku", "sonnet", "opus", "fable", "default"]);
const CURSOR_META_MODELS = new Set(["default", "auto"]);

function inferDesiredTier(desiredModel: string, hint: string): "low" | "medium" | "high" {
  const lower = desiredModel.toLowerCase();
  const h = hint.toLowerCase();
  if (
    h === "scout" ||
    h === "low" ||
    /(?:lite|haiku|mini|nano|-low\b|_low\b)/.test(lower)
  ) {
    return "low";
  }
  if (
    h === "architect" ||
    h === "critic" ||
    h === "high" ||
    h === "visual-ui" ||
    h === "design" ||
    /(?:opus|pro|carbon|argon|-high\b|xhigh)/.test(lower)
  ) {
    return "high";
  }
  return "medium";
}

export function selectBestAvailableModel(
  harness: HarnessId,
  desiredModel: string,
  hint: string,
  availableModels: readonly string[]
): string | null {
  const cleanAll = availableModels.filter((m) => Boolean(m && !m.includes(" ")));
  const usable = cleanAll.filter((m) => m !== "default" && m !== "auto");
  const pool = usable.length > 0 ? usable : cleanAll;
  if (pool.length === 0) return null;

  const desiredLower = desiredModel.toLowerCase().trim();
  const baseSlug = desiredLower.includes("/")
    ? desiredLower.split("/").pop() || desiredLower
    : desiredLower;

  // 1. Provider-prefixed or exact basename match (e.g. z-ai/glm-5.3-flash -> nvidia/z-ai/glm-5.3-flash)
  const exactSuffix = pool.find((m) => {
    const ml = m.toLowerCase();
    return (
      ml === desiredLower ||
      ml.endsWith(`/${desiredLower}`) ||
      (baseSlug.length >= 4 && ml.endsWith(`/${baseSlug}`))
    );
  });
  if (exactSuffix) return exactSuffix;

  // 2. Specialized research / DeepSeek family preference
  if (desiredLower.includes("deepseek") || hint.toLowerCase() === "research") {
    const ds = pool.find((m) => m.toLowerCase().includes("deepseek"));
    if (ds) return ds;
  }

  // 3. Harness & tier-aware mainstream model preference
  const tier = inferDesiredTier(desiredModel, hint);
  let patterns: RegExp[] = [];

  switch (harness) {
    case "antigravity":
      patterns =
        tier === "low"
          ? [/gemini-.*flash-low/i, /flash-low/i, /gemini-.*flash-medium/i, /flash/i]
          : tier === "high"
            ? [
                /gemini-.*carbon-high/i,
                /gemini-.*argon-high/i,
                /claude-opus-.*-high/i,
                /claude-sonnet-.*-high/i,
                /-high$/i,
              ]
            : [/gemini-.*flash-medium/i, /gemini-.*carbon-medium/i, /flash/i, /-medium$/i];
      break;
    case "codex":
      if (tier === "low") {
        patterns = [/mini/i, /nano/i, /flash/i];
      } else {
        const nonMini = pool.find((m) => !/mini|nano/i.test(m));
        if (nonMini) return nonMini;
      }
      break;
    case "opencode":
      patterns = [/glm-5/i, /claude-sonnet/i, /gpt-5/i, /qwen.*coder/i, /deepseek/i];
      break;
    case "claude-code":
      patterns =
        tier === "low"
          ? [/^haiku$/i, /haiku/i, /flash/i]
          : tier === "high"
            ? [/^opus$/i, /opus/i, /^sonnet$/i, /sonnet/i, /deepseek/i, /qwen.*coder/i, /glm-5/i]
            : [/^sonnet$/i, /sonnet/i, /glm-5/i, /qwen.*coder/i, /deepseek/i];
      break;
    case "cursor":
      patterns =
        tier === "low"
          ? [/claude-haiku-.*-medium$/i, /gemini-.*flash-low$/i, /gpt-.*-mini-medium$/i]
          : tier === "high"
            ? [/^claude-opus-[\d.-]+-high$/i, /^claude-sonnet-[\d.-]+-high$/i, /^gpt-[\d.-]+-high$/i, /-high$/i]
            : [/^claude-sonnet-4-6$/i, /^claude-sonnet-[\d.-]+-medium$/i, /claude-sonnet/i, /^gpt-[\d.-]+-medium$/i];
      break;
  }

  for (const pat of patterns) {
    const matched = pool.find((m) => pat.test(m));
    if (matched) return matched;
  }

  return pool[0] ?? null;
}

function isHarnessCatalogAuthoritative(
  harness: HarnessId,
  available: readonly string[],
  strictSingleEntry: boolean
): boolean {
  if (available.length === 0) return false;
  if (harness === "claude-code" || harness === "cursor") {
    return strictSingleEntry || available.length >= 2;
  }
  return true;
}

function isModelValidInCatalog(
  harness: HarnessId,
  model: string,
  availableSet: ReadonlySet<string>,
  isLightSubagentSlot: boolean
): boolean {
  const trimmed = model.trim();
  if (!trimmed) return true;
  if (isLightSubagentSlot && harness === "antigravity") {
    return ANTIGRAVITY_NATIVE_TIERS.has(trimmed.toLowerCase());
  }
  if (harness === "claude-code" && CLAUDE_NATIVE_ALIASES.has(trimmed.toLowerCase())) {
    return true;
  }
  if (harness === "cursor" && CURSOR_META_MODELS.has(trimmed.toLowerCase())) {
    return true;
  }
  return availableSet.has(trimmed);
}

export function inspectOrRemapRoutingModels(
  routingObj: Record<string, unknown>,
  catalog: HarnessModelCatalog,
  options?: {
    applyRemap?: boolean;
    strictSingleEntryCatalogs?: boolean;
  }
): {
  warnings: RoutingModelWarning[];
  remapped: RoutingModelRemap[];
  changed: boolean;
} {
  const applyRemap = Boolean(options?.applyRemap);
  const strictSingle = Boolean(options?.strictSingleEntryCatalogs);
  const warnings: RoutingModelWarning[] = [];
  const remapped: RoutingModelRemap[] = [];
  let changed = false;

  const catalogSets: Record<HarnessId, Set<string>> = {
    antigravity: new Set(catalog.antigravity ?? []),
    "claude-code": new Set(catalog["claude-code"] ?? []),
    codex: new Set(catalog.codex ?? []),
    opencode: new Set(catalog.opencode ?? []),
    cursor: new Set(catalog.cursor ?? []),
  };

  const checkModelSlot = (
    harness: HarnessId,
    currentModel: string,
    hint: string,
    location: string,
    isLightSlot: boolean,
    applyChange: (nextModel: string) => void
  ) => {
    const available = catalog[harness] ?? [];
    if (!isHarnessCatalogAuthoritative(harness, available, strictSingle)) {
      return;
    }
    if (isModelValidInCatalog(harness, currentModel, catalogSets[harness], isLightSlot)) {
      return;
    }
    const replacement = selectBestAvailableModel(harness, currentModel, hint, available);
    if (!replacement || replacement === currentModel) {
      return;
    }
    if (applyRemap) {
      applyChange(replacement);
      remapped.push({
        location,
        harness,
        fromModel: currentModel,
        toModel: replacement,
      });
      changed = true;
    } else {
      warnings.push({
        location,
        harness,
        configuredModel: currentModel,
        suggestedModel: replacement,
      });
    }
  };

  // 1. Inspect lightSubagents (skip antigravity native tier enum slots)
  if (routingObj.lightSubagents && typeof routingObj.lightSubagents === "object") {
    const lightRoot = routingObj.lightSubagents as Record<string, unknown>;
    const harnessKeys: HarnessId[] = ["claude-code", "opencode", "codex", "cursor"];
    for (const hKey of harnessKeys) {
      const hBlock = lightRoot[hKey];
      if (!hBlock || typeof hBlock !== "object") continue;
      const hRec = hBlock as Record<string, unknown>;
      for (const [slotKey, slotVal] of Object.entries(hRec)) {
        const locBase = `lightSubagents.${hKey}.${slotKey}`;
        if (typeof slotVal === "string") {
          checkModelSlot(hKey, slotVal, slotKey, locBase, true, (nextModel) => {
            hRec[slotKey] = nextModel;
          });
        } else if (Array.isArray(slotVal)) {
          for (let idx = 0; idx < slotVal.length; idx++) {
            const item = slotVal[idx];
            if (typeof item === "string") {
              checkModelSlot(hKey, item, slotKey, `${locBase}[${idx}]`, true, (nextModel) => {
                slotVal[idx] = nextModel;
              });
            }
          }
        } else if (slotVal && typeof slotVal === "object") {
          const objSlot = slotVal as Record<string, unknown>;
          if (typeof objSlot.model === "string") {
            checkModelSlot(hKey, objSlot.model, slotKey, `${locBase}.model`, true, (nextModel) => {
              objSlot.model = nextModel;
            });
          }
          if (Array.isArray(objSlot.fallbacks)) {
            const fbs = objSlot.fallbacks;
            for (let idx = 0; idx < fbs.length; idx++) {
              const fbItem = fbs[idx];
              if (typeof fbItem === "string") {
                checkModelSlot(
                  hKey,
                  fbItem,
                  slotKey,
                  `${locBase}.fallbacks[${idx}]`,
                  true,
                  (nextModel) => {
                    fbs[idx] = nextModel;
                  }
                );
              }
            }
          }
        }
      }
    }
  }

  // 2. Inspect HEAVY route groups (agents, categories, heavyRouting)
  const walkRouteGroup = (group: unknown, groupPrefix: string) => {
    if (!group || typeof group !== "object") return;
    for (const [routeKey, routeVal] of Object.entries(group as Record<string, unknown>)) {
      if (!routeVal || typeof routeVal !== "object") continue;
      const entry = routeVal as Record<string, unknown>;
      if (typeof entry.harness === "string" && typeof entry.model === "string") {
        const h = entry.harness as HarnessId;
        if (h in catalogSets) {
          checkModelSlot(h, entry.model, routeKey, `${groupPrefix}.${routeKey}`, false, (nextModel) => {
            entry.model = nextModel;
            entry.modelFamily = inferModelFamily(nextModel, h);
          });
        }
      }
      if (Array.isArray(entry.fallbacks)) {
        const fbs = entry.fallbacks;
        for (let idx = 0; idx < fbs.length; idx++) {
          const fb = fbs[idx];
          if (!fb || typeof fb !== "object") continue;
          const fbRec = fb as Record<string, unknown>;
          if (typeof fbRec.harness === "string" && typeof fbRec.model === "string") {
            const h = fbRec.harness as HarnessId;
            if (h in catalogSets) {
              checkModelSlot(
                h,
                fbRec.model,
                routeKey,
                `${groupPrefix}.${routeKey}.fallbacks[${idx}]`,
                false,
                (nextModel) => {
                  fbRec.model = nextModel;
                  fbRec.modelFamily = inferModelFamily(nextModel, h);
                }
              );
            }
          }
        }
      }
    }
  };

  walkRouteGroup(routingObj.agents, "agents");
  walkRouteGroup(routingObj.categories, "categories");
  if (routingObj.heavyRouting && typeof routingObj.heavyRouting === "object") {
    const heavy = routingObj.heavyRouting as Record<string, unknown>;
    walkRouteGroup(heavy.agents, "heavyRouting.agents");
    walkRouteGroup(heavy.categories, "heavyRouting.categories");
  }

  return { warnings, remapped, changed };
}