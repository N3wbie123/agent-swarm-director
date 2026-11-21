/**
 * OpenCode V1 Plugin Isolation & Execution Smoke Tests (tests/opencode-v1-isolation.test.ts)
 *
 * Verifies:
 * 1. Static isolation: V1-only plugin implementation symbols exist ONLY in
 *    `src/adapters/opencode-v1.ts` and NOT in `src/adapters/opencode.ts`,
 *    `src/core/*.ts`, or other `src/** /*.ts` modules.
 * 2. Frozen module exports, freeze banner, Bun `process.execPath` workaround,
 *    and delegation from `src/adapters/opencode.ts`.
 * 3. Host execution smoke test:
 *    (a) `tool.execute.before` forwards hook payload and denies on non-zero CLI exit.
 *    (b) `session.idle` invokes `stop` hook and pushes async completion callback
 *        via `client.session.prompt` exactly once (`notified: true`).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { generateOpencodeGuardPlugin } from "../src/adapters/opencode.ts";
import {
  OPENCODE_V1_PLUGIN_MARKER,
  OPENCODE_V1_PLUGIN_RELATIVE_PATH,
  generateOpencodeV1GuardPlugin,
} from "../src/adapters/opencode-v1.ts";

const V1_ISOLATED_SYMBOLS = [
  "AsdPolicyGuardPlugin",
  "scanAndNotifyCompletedJobs",
  "client.session.prompt",
  "tool.execute.before",
] as const;

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("OpenCode V1 Plugin Isolation & Compatibility Freeze", () => {
  test("static isolation: V1-only plugin symbols exist ONLY in src/adapters/opencode-v1.ts", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const v1Path = path.join(repoRoot, "src", "adapters", "opencode-v1.ts");
    const opencodePath = path.join(repoRoot, "src", "adapters", "opencode.ts");
    const coreDir = path.join(repoRoot, "src", "core");
    const srcDir = path.join(repoRoot, "src");

    const v1Source = fs.readFileSync(v1Path, "utf8");
    assert.ok(
      v1Source.includes("FROZEN COMPATIBILITY MODULE"),
      "opencode-v1.ts must carry the frozen compatibility module banner"
    );
    for (const symbol of V1_ISOLATED_SYMBOLS) {
      assert.ok(
        v1Source.includes(symbol),
        `opencode-v1.ts must contain V1 symbol: ${symbol}`
      );
    }

    const opencodeSource = fs.readFileSync(opencodePath, "utf8");
    for (const symbol of V1_ISOLATED_SYMBOLS) {
      assert.equal(
        opencodeSource.includes(symbol),
        false,
        `src/adapters/opencode.ts must NOT contain V1 symbol: ${symbol}`
      );
    }

    const coreFiles = fs
      .readdirSync(coreDir)
      .filter((name) => name.endsWith(".ts"));
    assert.ok(coreFiles.length > 0, "Expected TypeScript files in src/core");
    for (const file of coreFiles) {
      const content = fs.readFileSync(path.join(coreDir, file), "utf8");
      for (const symbol of V1_ISOLATED_SYMBOLS) {
        assert.equal(
          content.includes(symbol),
          false,
          `src/core/${file} must NOT contain V1 symbol: ${symbol}`
        );
      }
    }

    const allSrcTsFiles = collectTsFiles(srcDir);
    for (const filePath of allSrcTsFiles) {
      if (path.resolve(filePath) === path.resolve(v1Path)) continue;
      const content = fs.readFileSync(filePath, "utf8");
      for (const symbol of V1_ISOLATED_SYMBOLS) {
        assert.equal(
          content.includes(symbol),
          false,
          `${path.relative(repoRoot, filePath)} must NOT contain V1 symbol: ${symbol}`
        );
      }
    }
  });

  test("V1 constants, delegation from opencode.ts, and Bun process.execPath Node-baking workaround", () => {
    assert.equal(OPENCODE_V1_PLUGIN_MARKER, "// ASD-MANAGED-OPENCODE-PLUGIN");
    assert.equal(OPENCODE_V1_PLUGIN_RELATIVE_PATH, "plugin/asd-guard.js");

    const v1Output = generateOpencodeV1GuardPlugin("/tmp/asd-cli.ts", process.execPath, 250);
    const delegatedOutput = generateOpencodeGuardPlugin("/tmp/asd-cli.ts", process.execPath, 250);
    assert.equal(delegatedOutput, v1Output);
    assert.ok(v1Output.startsWith(OPENCODE_V1_PLUGIN_MARKER));

    // When sync runs from standalone Bun/OpenCode binary, fallback to "node"
    const bunBaked = generateOpencodeV1GuardPlugin(
      "/tmp/asd-cli.ts",
      "C:\\Program Files\\OpenCode\\opencode.exe"
    );
    assert.ok(bunBaked.includes('const ASD_NODE_BIN = "node";'));

    // When sync runs from Node.js, bake in normalized Node binary path
    const nodeBaked = generateOpencodeV1GuardPlugin(
      "C:\\repo\\src\\cli\\index.ts",
      "C:\\Program Files\\nodejs\\node.exe"
    );
    assert.ok(
      nodeBaked.includes('const ASD_NODE_BIN = "C:/Program Files/nodejs/node.exe";')
    );
  });

  test("mock V1 plugin host execution: tool.execute.before forwarding/denial and session.idle stop + async callback", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asd-oc-v1-smoke-"));
    try {
      const hookLogPath = path.join(tmpRoot, "hook-invocations.jsonl");
      const mockCliPath = path.join(tmpRoot, "mock-asd-cli.mjs");

      const mockCliSource = `
import * as fs from "node:fs";

const hookLogPath = ${JSON.stringify(hookLogPath)};
const stdinRaw = fs.readFileSync(0, "utf8");
const payload = stdinRaw ? JSON.parse(stdinRaw) : {};
const args = process.argv.slice(2);

fs.appendFileSync(hookLogPath, JSON.stringify({ args, payload }) + "\\n", "utf8");

if (args[1] === "pre-tool-use" && payload?.tool_input?.deny === true) {
  process.stderr.write("Blocked by mock PreToolUse policy");
  process.exit(2);
}
process.exit(0);
`;
      fs.writeFileSync(mockCliPath, mockCliSource, "utf8");

      const pluginSource = generateOpencodeV1GuardPlugin(mockCliPath, process.execPath, 25);
      const pluginFile = path.join(tmpRoot, "asd-guard-v1.mjs");
      fs.writeFileSync(pluginFile, pluginSource, "utf8");

      const mod = (await import(pathToFileURL(pluginFile).href)) as {
        AsdPolicyGuardPlugin: (ctx?: {
          client?: {
            session?: {
              prompt?: (arg: {
                path: { id: string };
                body: { noReply: boolean; parts: Array<{ type: string; text: string }> };
              }) => Promise<unknown>;
            };
          };
          directory?: string;
        }) => Promise<{
          "tool.execute.before": (
            input: Record<string, unknown>,
            output?: Record<string, unknown>
          ) => Promise<void>;
          event: (arg?: { event?: Record<string, unknown> }) => Promise<void>;
        }>;
      };

      const promptCalls: Array<{
        path: { id: string };
        body: { noReply: boolean; parts: Array<{ type: string; text: string }> };
      }> = [];

      const plugin = await mod.AsdPolicyGuardPlugin({
        directory: tmpRoot,
        client: {
          session: {
            prompt: async (payload) => {
              promptCalls.push(payload);
              return {};
            },
          },
        },
      });

      // (a) tool.execute.before forwards payload to `hook pre-tool-use` and allows exit 0
      await plugin["tool.execute.before"](
        {
          tool: "bash",
          sessionID: "oc-v1-session-1",
          args: { command: "echo hello" },
        },
        {
          args: { command: "echo hello" },
        }
      );

      // (a) tool.execute.before denies when mock CLI exits non-zero
      await assert.rejects(
        () =>
          plugin["tool.execute.before"](
            {
              tool: "write",
              sessionID: "oc-v1-session-1",
              args: { deny: true, filePath: "blocked.ts" },
            },
            {
              args: { deny: true, filePath: "blocked.ts" },
            }
          ),
        (err: unknown) =>
          err instanceof Error && err.message.includes("Blocked by mock PreToolUse policy")
      );

      // (b) Prepare completed async-dispatch job and trigger session.idle
      const sessionDir = path.join(tmpRoot, ".asd", "sessions", "asd-wave-v1");
      fs.mkdirSync(sessionDir, { recursive: true });
      const jobPath = path.join(sessionDir, "async-dispatch.json");
      fs.writeFileSync(
        jobPath,
        JSON.stringify(
          {
            jobId: "job-v1",
            sessionId: "asd-wave-v1",
            turn: 3,
            status: "done",
            startedAt: Date.now() - 250,
            finishedAt: Date.now(),
            summary: "Turn 3 V1 wave finished.",
            progressBoard: "## Progress\n- [x] T3.1",
          },
          null,
          2
        ),
        "utf8"
      );

      await plugin.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "oc-v1-session-1" },
        },
      });

      // Verify prompt delivered exactly once and job persisted with notified: true
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0]?.path.id, "oc-v1-session-1");
      assert.equal(promptCalls[0]?.body.noReply, false);
      assert.ok(
        promptCalls[0]?.body.parts[0]?.text.includes("[ASD Async Dispatch DONE] Turn 3 (asd-wave-v1)")
      );
      assert.ok(promptCalls[0]?.body.parts[0]?.text.includes("Turn 3 V1 wave finished."));

      const updatedJob = JSON.parse(fs.readFileSync(jobPath, "utf8")) as {
        notified?: boolean;
        notifyAttempts?: number;
        openCodeSessionId?: string;
      };
      assert.equal(updatedJob.notified, true);
      assert.equal(updatedJob.notifyAttempts, 1);
      assert.equal(updatedJob.openCodeSessionId, "oc-v1-session-1");

      // Duplicate idle & poll tick must NOT trigger another prompt
      await plugin.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "oc-v1-session-1" },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(promptCalls.length, 1);

      // Verify all recorded hook invocations (2x pre-tool-use + 2x stop)
      const invocations = fs
        .readFileSync(hookLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              payload: Record<string, unknown>;
            }
        );
      assert.equal(invocations.length, 4);
      assert.deepEqual(invocations[0]?.args, ["hook", "pre-tool-use", "--harness", "opencode"]);
      assert.deepEqual(invocations[0]?.payload, {
        tool_name: "bash",
        tool_input: { command: "echo hello" },
        cwd: tmpRoot,
        session_id: "oc-v1-session-1",
      });
      assert.deepEqual(invocations[1]?.args, ["hook", "pre-tool-use", "--harness", "opencode"]);
      assert.deepEqual(invocations[1]?.payload, {
        tool_name: "write",
        tool_input: { deny: true, filePath: "blocked.ts" },
        cwd: tmpRoot,
        session_id: "oc-v1-session-1",
      });
      assert.deepEqual(invocations[2]?.args, ["hook", "stop", "--harness", "opencode"]);
      assert.deepEqual(invocations[2]?.payload, {
        session_id: "oc-v1-session-1",
        cwd: tmpRoot,
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
