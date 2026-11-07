/**
 * ASD v2.5.0 Harness Adapter & Plugin Registry (src/adapters/registry.ts)
 *
 * Provides both the legacy getAdapter resolver and the modern HC-1
 * HarnessRuntimePlugin & HarnessProvisionerPlugin registry for all 5 harnesses.
 *
 * Invariants:
 * - Erasable TypeScript only (zero enums, type-only imports where applicable).
 * - Zero external runtime npm dependencies.
 * - Risk 6: getCapabilities() returns strictly the 5 core orchestration flags.
 */

import { createStreamParser, type StreamParserOptions } from "../core/drivers.ts";
import {
  buildSpawnSpec,
  type HeadlessHarnessCommandOptions,
} from "../core/session-tracker.ts";
import { abortSession, type AbortSessionOptions } from "../core/spawner.ts";
import { readHarnessTranscript } from "../core/transcripts.ts";
import {
  registerHarnessProvisionerPlugin,
  registerHarnessRuntimePlugin,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessId,
  type HarnessProvisionerPlugin,
  type HarnessRuntimePlugin,
  type StreamParserContext,
} from "../core/types.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import {
  runAsdDoctor,
  syncAgentModelsIfNeeded,
  syncHarnessConfigs,
} from "./installer.ts";
import { opencodeAdapter } from "./opencode.ts";

export const HARNESS_IDS: readonly HarnessId[] = [
  "claude-code",
  "opencode",
  "codex",
  "antigravity",
  "cursor",
];

/**
 * Returns strictly the 5 core orchestration capabilities (Risk 6 constraint).
 * No UI, theme, or badge metadata is exposed.
 */
export function getHarnessCapabilities(harnessId: HarnessId): HarnessCapabilities {
  return {
    supportsSessionResume: true,
    canReadNativeTranscript: harnessId !== "cursor",
    transportMode: "cli-stdio",
    supportsNativeMcp: true,
    supportsNativeHooks: harnessId !== "codex",
  };
}

export function createHarnessRuntimePlugin(harnessId: HarnessId): HarnessRuntimePlugin {
  return {
    id: harnessId,
    getCapabilities() {
      return getHarnessCapabilities(harnessId);
    },
    buildSpawnSpec(opts: Record<string, unknown>) {
      return buildSpawnSpec({
        ...opts,
        harness: harnessId,
        prompt: typeof opts.prompt === "string" ? opts.prompt : String(opts.prompt ?? ""),
        model: typeof opts.model === "string" ? opts.model : undefined,
        thinkingEffort: typeof opts.thinkingEffort === "string" ? opts.thinkingEffort : undefined,
        reasoningEffort: typeof opts.reasoningEffort === "string" ? opts.reasoningEffort : undefined,
        streaming: Boolean(opts.streaming),
      } as HeadlessHarnessCommandOptions & { resumeSessionId?: string });
    },
    buildResumeSpec(opts: Record<string, unknown>) {
      const resumeSessionId = String(opts.resumeSessionId ?? opts.harnessSessionId ?? "");
      return buildSpawnSpec({
        ...opts,
        harness: harnessId,
        prompt: typeof opts.prompt === "string" ? opts.prompt : String(opts.prompt ?? ""),
        model: typeof opts.model === "string" ? opts.model : undefined,
        thinkingEffort: typeof opts.thinkingEffort === "string" ? opts.thinkingEffort : undefined,
        reasoningEffort: typeof opts.reasoningEffort === "string" ? opts.reasoningEffort : undefined,
        streaming: Boolean(opts.streaming),
        resumeSessionId,
      } as HeadlessHarnessCommandOptions & { resumeSessionId?: string });
    },
    createStreamParser(ctx: StreamParserContext & { now?: () => number }) {
      return createStreamParser({
        ...(ctx as StreamParserOptions),
        harness: harnessId,
      });
    },
    abortSession(handle: unknown) {
      const handleObj =
        typeof handle === "object" && handle ? (handle as Record<string, unknown>) : {};
      return abortSession({
        ...handleObj,
        harness: harnessId,
      } as AbortSessionOptions);
    },
    readTranscript(sessionId: string, opts?: Record<string, unknown>) {
      return readHarnessTranscript(harnessId, sessionId, opts);
    },
  };
}

export function createHarnessProvisionerPlugin(
  harnessId: HarnessId
): HarnessProvisionerPlugin {
  return {
    id: harnessId,
    doctor(opts) {
      return runAsdDoctor(opts);
    },
    syncAgentModels(opts) {
      return syncAgentModelsIfNeeded(opts);
    },
    configureEnvironment(opts) {
      return syncHarnessConfigs(opts);
    },
  };
}

export function registerDefaultHarnessPlugins(): void {
  for (const id of HARNESS_IDS) {
    registerHarnessRuntimePlugin(createHarnessRuntimePlugin(id));
    registerHarnessProvisionerPlugin(createHarnessProvisionerPlugin(id));
  }
}

// Automatically register default plugins on module load
registerDefaultHarnessPlugins();

/** Resolves a harness ID to its adapter; unknown IDs fall back to claude-code. */
export function getAdapter(harnessId?: string): HarnessAdapter {
  switch (harnessId) {
    case "claude-code":
      return claudeCodeAdapter;
    case "opencode":
      return opencodeAdapter;
    case "codex":
      return codexAdapter;
    case "antigravity":
      return antigravityAdapter;
    case "cursor":
      return cursorAdapter;
    default:
      return claudeCodeAdapter;
  }
}
