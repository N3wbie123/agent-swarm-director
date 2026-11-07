/**
 * ASD Core Purity & HarnessPlugin Registry Tests (tests/core-purity.test.ts)
 *
 * Verifies:
 * 1. HC-1: Strict Core Purity: ZERO files in src/core/ import from ../adapters, ../mcp, or ../cli.
 * 2. Core Harness Plugin Registry: registerHarnessRuntimePlugin and getHarnessRuntimePlugin.
 * 3. Core Harness Provisioner Registry: registerHarnessProvisionerPlugin and getHarnessProvisionerPlugin.
 * 4. Core Installer Hooks Registry: registerCoreInstallerHooks and getCoreInstallerHooks.
 * 5. buildPromptForTask Purity: Works identically from src/core/session-services.ts and re-exported from src/mcp/server.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import type { TaskRow } from "../src/core/db.ts";
import { buildPromptForTask as buildPromptFromCore } from "../src/core/session-services.ts";
import {
  getCoreInstallerHooks,
  getHarnessProvisionerPlugin,
  getHarnessRuntimePlugin,
  listHarnessProvisionerPlugins,
  listHarnessRuntimePlugins,
  registerCoreInstallerHooks,
  registerHarnessProvisionerPlugin,
  registerHarnessRuntimePlugin,
  type HarnessCapabilities,
  type HarnessProvisionerPlugin,
  type HarnessRuntimePlugin,
} from "../src/core/types.ts";
import { buildPromptForTask as buildPromptFromMcp } from "../src/mcp/server.ts";

describe("Strict Core Purity (HC-1)", () => {
  test("assert ZERO imports from ../adapters, ../mcp, or ../cli across all files in src/core", () => {
    const coreDir = path.resolve(import.meta.dirname, "../src/core");
    const coreFiles = fs
      .readdirSync(coreDir)
      .filter((file) => file.endsWith(".ts"));

    assert.ok(coreFiles.length >= 10, "Expected at least 10 TypeScript files in src/core");

    const forbiddenPattern =
      /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?|export\s+[\w*\s{},]*\s+from\s+|require\s*\(\s*|import\s*\(\s*)["']\.\.\/(adapters|mcp|cli)(?:\/|\.ts|["'])/;

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of coreFiles) {
      const fullPath = path.join(coreDir, file);
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (forbiddenPattern.test(line)) {
          violations.push({
            file: `src/core/${file}`,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Core purity violations found:\n${violations
        .map((v) => `  ${v.file}:${v.line} -> ${v.text}`)
        .join("\n")}`
    );
  });
});

describe("HarnessPlugin & Core Registry Contracts", () => {
  test("registerHarnessRuntimePlugin and getHarnessRuntimePlugin manage runtime plugins", () => {
    const caps: HarnessCapabilities = {
      supportsSessionResume: true,
      canReadNativeTranscript: true,
      transportMode: "cli-stdio",
      supportsNativeMcp: true,
      supportsNativeHooks: false,
    };

    const mockPlugin: HarnessRuntimePlugin = {
      id: "opencode",
      getCapabilities: () => caps,
      buildSpawnSpec: (opts) => ({
        command: "opencode",
        args: ["run", String(opts.prompt ?? "")],
      }),
    };

    registerHarnessRuntimePlugin(mockPlugin);

    const retrieved = getHarnessRuntimePlugin("opencode");
    assert.ok(retrieved, "Runtime plugin should be retrieved");
    assert.strictEqual(retrieved.id, "opencode");
    assert.deepEqual(retrieved.getCapabilities(), caps);
    assert.deepEqual(retrieved.buildSpawnSpec?.({ prompt: "hello" }), {
      command: "opencode",
      args: ["run", "hello"],
    });
    assert.ok(listHarnessRuntimePlugins().some((p) => p.id === "opencode"));
  });

  test("registerHarnessProvisionerPlugin and getHarnessProvisionerPlugin manage provisioner plugins", async () => {
    let doctorCalled = false;
    const mockProvisioner: HarnessProvisionerPlugin = {
      id: "claude-code",
      doctor: async () => {
        doctorCalled = true;
        return { ok: true, version: "1.0.0" };
      },
    };

    registerHarnessProvisionerPlugin(mockProvisioner);

    const retrieved = getHarnessProvisionerPlugin("claude-code");
    assert.ok(retrieved, "Provisioner plugin should be retrieved");
    assert.strictEqual(retrieved.id, "claude-code");

    const docRes = await retrieved.doctor?.();
    assert.strictEqual(doctorCalled, true);
    assert.deepEqual(docRes, { ok: true, version: "1.0.0" });
    assert.ok(listHarnessProvisionerPlugins().some((p) => p.id === "claude-code"));
  });

  test("registerCoreInstallerHooks and getCoreInstallerHooks manage installer callbacks", async () => {
    const prevHooks = getCoreInstallerHooks();
    try {
      let syncCalledWithProject = "";
      registerCoreInstallerHooks({
        syncAgentModelsIfNeeded: (opts) => {
          syncCalledWithProject = opts?.projectRoot ?? "";
          return { updated: true, filesWritten: ["agent.md"] };
        },
      });

      const hooks = getCoreInstallerHooks();
      assert.ok(hooks, "Installer hooks should be registered");
      const syncRes = hooks.syncAgentModelsIfNeeded?.({ projectRoot: "/test/project" });
      assert.strictEqual(syncCalledWithProject, "/test/project");
      assert.deepEqual(syncRes, { updated: true, filesWritten: ["agent.md"] });
    } finally {
      if (prevHooks) {
        registerCoreInstallerHooks(prevHooks);
      }
    }
  });
});

describe("buildPromptForTask Purity & Backward Compatibility", () => {
  test("buildPromptForTask produces identical output when imported from core or re-exported from mcp/server", () => {
    const sampleTask: TaskRow = {
      session_id: "test-sess",
      task_id: "T1.1",
      turn: 1,
      title: "Test Task Title",
      track: "LIGHT",
      role: "architect",
      category: "general",
      difficulty: "medium",
      status: "running",
      assigned_harness: "opencode",
      assigned_model: "glm-5",
      worktree_path: null,
      sub_session_id: null,
      commit_sha: null,
      duration_ms: null,
      is_cross_scope: 0,
      follow_up_of: null,
      attempts: 0,
      thinking_effort: "high",
      depends_on_json: JSON.stringify([]),
      target_files_json: JSON.stringify(["src/core/types.ts", "src/core/router.ts"]),
      context_hint: "Check purity",
      acceptance: "Zero violations",
      verify_cmd: "node --test",
      done_claim_json: null,
      updated_at: Date.now(),
    };

    const decisions = ["Decision 1: purity first", "Decision 2: register hooks"];
    const files = ["src/core/types.ts"];

    const promptFromCore = buildPromptFromCore(sampleTask, decisions, files);
    const promptFromMcp = buildPromptFromMcp(sampleTask, decisions, files);

    assert.strictEqual(promptFromCore, promptFromMcp, "MCP re-export must match Core output 100%");
    assert.ok(promptFromCore.includes("# ASD Subagent Task: T1.1"));
    assert.ok(promptFromCore.includes("src/core/types.ts"));
    assert.ok(promptFromCore.includes("Decision 1: purity first"));
    assert.ok(promptFromCore.includes("```asd-report"));
  });
});
