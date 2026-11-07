import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAdapter,
  HARNESS_IDS,
  registerDefaultHarnessPlugins,
} from "../src/adapters/registry.ts";
import { createStreamParser } from "../src/core/drivers.ts";
import { buildSpawnSpec } from "../src/core/session-tracker.ts";
import { readHarnessTranscript } from "../src/core/transcripts.ts";
import {
  getHarnessProvisionerPlugin,
  getHarnessRuntimePlugin,
  listHarnessProvisionerPlugins,
  listHarnessRuntimePlugins,
} from "../src/core/types.ts";

describe("T5.1: 5-Harness Plugin Integration & Registry Verification", () => {
  it("registers all 5 default harness plugins automatically", () => {
    registerDefaultHarnessPlugins();

    const runtimePlugins = listHarnessRuntimePlugins();
    const provisionerPlugins = listHarnessProvisionerPlugins();

    assert.equal(runtimePlugins.length, 5);
    assert.equal(provisionerPlugins.length, 5);

    for (const id of HARNESS_IDS) {
      const rt = getHarnessRuntimePlugin(id);
      assert.ok(rt, `Runtime plugin for ${id} must exist`);
      assert.equal(rt.id, id);

      const prov = getHarnessProvisionerPlugin(id);
      assert.ok(prov, `Provisioner plugin for ${id} must exist`);
      assert.equal(prov.id, id);
    }
  });

  it("Risk 6: getCapabilities() returns strictly the 5 core orchestration flags with zero UI metadata", () => {
    const expectedKeys = [
      "canReadNativeTranscript",
      "supportsNativeHooks",
      "supportsNativeMcp",
      "supportsSessionResume",
      "transportMode",
    ];

    for (const id of HARNESS_IDS) {
      const rt = getHarnessRuntimePlugin(id)!;
      const caps = rt.getCapabilities();

      assert.deepEqual(
        Object.keys(caps).sort(),
        expectedKeys,
        `Capabilities for ${id} must have exactly the 5 allowed flags`
      );

      assert.equal(caps.supportsSessionResume, true);
      assert.equal(caps.supportsNativeMcp, true);
      assert.equal(caps.transportMode, "cli-stdio");

      if (id === "cursor") {
        assert.equal(caps.canReadNativeTranscript, false, "Cursor native store.db is opaque");
        assert.equal(caps.supportsNativeHooks, true);
      } else if (id === "codex") {
        assert.equal(caps.canReadNativeTranscript, true);
        assert.equal(caps.supportsNativeHooks, false, "Codex lacks native PreToolUse hooks");
      } else {
        assert.equal(caps.canReadNativeTranscript, true);
        assert.equal(caps.supportsNativeHooks, true);
      }
    }
  });

  it("verifies functional equivalence between plugin methods and core facades", () => {
    // 1. buildSpawnSpec equivalence (claude-code long prompt)
    const claudePlugin = getHarnessRuntimePlugin("claude-code")!;
    const longPrompt = "A".repeat(1600);

    const pluginSpec = claudePlugin.buildSpawnSpec!({ prompt: longPrompt });
    const directSpec = buildSpawnSpec({ harness: "claude-code", prompt: longPrompt });
    assert.deepEqual(pluginSpec, directSpec);

    // 2. buildResumeSpec equivalence (codex resume)
    const codexPlugin = getHarnessRuntimePlugin("codex")!;
    const pluginResume = codexPlugin.buildResumeSpec!({
      prompt: "continue task",
      resumeSessionId: "cx-thread-99",
    });
    const directResume = buildSpawnSpec({
      harness: "codex",
      prompt: "continue task",
      resumeSessionId: "cx-thread-99",
    });
    assert.deepEqual(pluginResume, directResume);

    // 3. createStreamParser equivalence (opencode, deterministic timestamp)
    const fixedNow = () => 1700000000000;
    const ocPlugin = getHarnessRuntimePlugin("opencode")!;
    const pluginParser = ocPlugin.createStreamParser!({
      harness: "opencode",
      now: fixedNow,
    } as Parameters<NonNullable<typeof ocPlugin.createStreamParser>>[0]);
    const directParser = createStreamParser({ harness: "opencode", now: fixedNow });

    const testChunk = '{"part":{"type":"text","text":"equivalence check"}}\n';
    assert.deepEqual(
      pluginParser.pushChunk(testChunk),
      directParser.pushChunk(testChunk)
    );

    // 4. readTranscript equivalence (cursor nonexistent -> unsupported)
    const curPlugin = getHarnessRuntimePlugin("cursor")!;
    const pluginTr = curPlugin.readTranscript!("none-sess");
    const directTr = readHarnessTranscript("cursor", "none-sess");
    assert.deepEqual(pluginTr, directTr);
  });

  it("preserves backward compatibility of getAdapter", () => {
    for (const id of HARNESS_IDS) {
      const adapter = getAdapter(id);
      assert.ok(adapter);
      assert.equal(adapter.harnessId, id);
    }
    // Fallback on unknown
    assert.equal(getAdapter("unknown-harness").harnessId, "claude-code");
  });
});
