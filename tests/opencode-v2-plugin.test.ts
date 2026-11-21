/**
 * OpenCode V2 Canonical Guard Plugin & Profile Dispatch Tests (tests/opencode-v2-plugin.test.ts)
 *
 * Verifies:
 * 1. Static checks: zero external npm imports, OPENCODE_V2_PLUGIN_MARKER,
 *    Bun `opencode.exe` -> `"node"` baking fallback, and valid Node path baking.
 * 2. Real mock V2 plugin host execution:
 *    (a) `execute.before` for `write` to `.asd/PLAN.md` -> denies with Error & forwards payload.
 *    (b) `execute.before` for `shell` with dangerous command -> denies with Error.
 *    (c) `execute.before` for allowed tool -> resolves cleanly.
 *    (d) `event.subscribe` emitting `session.idle` -> invokes `stop` hook with `{ session_id, cwd }`.
 *    (e) Calling returned `cleanup()` aborts the subscription `AbortSignal`.
 * 3. Profile dispatch: `generateOpencodePluginForProfile` selects V2 for `2.3.2` and frozen V1 for `1.19.4` / `unknown`.
 * 4. `abortOpencodeSession` endpoint selection for V2 vs V1/default profiles.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  OPENCODE_V2_PLUGIN_ID,
  OPENCODE_V2_PLUGIN_MARKER,
  OPENCODE_V2_PLUGIN_RELATIVE_PATH,
  OpencodeAdapter,
  abortOpencodeSession,
  buildOpenCodeCapabilityProfile,
  detectOpenCodeVersion,
  generateOpencodePluginForProfile,
  generateOpencodeV2GuardPlugin,
  resolveOpenCodeCapabilityProfile,
} from "../src/adapters/opencode.ts";
import {
  OPENCODE_V1_PLUGIN_MARKER,
  OPENCODE_V1_PLUGIN_RELATIVE_PATH,
} from "../src/adapters/opencode-v1.ts";
import { ASD_VERSION } from "../src/core/types.ts";

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 15
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), `Condition not met within ${timeoutMs}ms`);
}

describe("OpenCode V2 Guard Plugin & Profile Dispatch", () => {
  test("static checks: zero external npm imports, V2 marker, and Bun/Node path baking", () => {
    assert.equal(OPENCODE_V2_PLUGIN_MARKER, "// ASD-MANAGED-OPENCODE-V2-PLUGIN");
    assert.equal(OPENCODE_V2_PLUGIN_ID, "asd-policy-guard");
    assert.equal(OPENCODE_V2_PLUGIN_RELATIVE_PATH, "plugins/asd-guard/index.js");

    assert.equal(typeof detectOpenCodeVersion, "function");
    assert.equal(typeof resolveOpenCodeCapabilityProfile, "function");
    assert.equal(typeof buildOpenCodeCapabilityProfile, "function");

    const source = generateOpencodeV2GuardPlugin("/tmp/asd-cli.ts", process.execPath);
    assert.ok(source.startsWith(`${OPENCODE_V2_PLUGIN_MARKER} (v${ASD_VERSION})`));

    // Verify ONLY node:child_process and node:fs are imported (zero external npm packages)
    const importMatches = [...source.matchAll(/import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    assert.deepEqual(importMatches, ["node:child_process", "node:fs"]);
    assert.equal(/\brequire\s*\(/.test(source), false);
    assert.equal(source.includes("@opencode"), false);

    // Ensure zero V1 symbols leaked into generated V2 plugin
    assert.equal(source.includes("AsdPolicyGuardPlugin"), false);
    assert.equal(source.includes("scanAndNotifyCompletedJobs"), false);
    assert.equal(source.includes("client.session.prompt"), false);
    assert.equal(source.includes("tool.execute.before"), false);

    // Bun opencode.exe fallback to "node"
    const bunBaked = generateOpencodeV2GuardPlugin(
      "/tmp/asd-cli.ts",
      "C:\\Program Files\\OpenCode\\opencode.exe"
    );
    assert.ok(bunBaked.includes('const ASD_NODE_BIN = "node";'));

    // Valid Windows Node.js binary baking
    const winNodeBaked = generateOpencodeV2GuardPlugin(
      "C:\\repo\\src\\cli\\index.ts",
      "C:\\Program Files\\nodejs\\node.exe"
    );
    assert.ok(winNodeBaked.includes('const ASD_CLI_PATH = "C:/repo/src/cli/index.ts";'));
    assert.ok(winNodeBaked.includes('const ASD_NODE_BIN = "C:/Program Files/nodejs/node.exe";'));

    // Valid POSIX Node.js binary baking
    const posixNodeBaked = generateOpencodeV2GuardPlugin("/repo/cli.js", "/usr/local/bin/node");
    assert.ok(posixNodeBaked.includes('const ASD_NODE_BIN = "/usr/local/bin/node";'));
  });

  test("mock V2 plugin host execution: execute.before denials/allow, session.idle stop hook, and cleanup AbortSignal", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asd-oc-v2-plugin-"));
    let cleanup: (() => void) | undefined;
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

if (args[1] === "pre-tool-use") {
  const filePath = String(payload?.tool_input?.filePath ?? payload?.tool_input?.path ?? "");
  if (payload?.tool_name === "write" && filePath.includes(".asd/PLAN.md")) {
    process.stderr.write("Blocked by ASD PreToolUse policy: protected .asd/ directory");
    process.exit(2);
  }
  const cmd = String(payload?.tool_input?.command ?? "");
  if (payload?.tool_name === "shell" && cmd.includes("rm -rf")) {
    process.stderr.write("Blocked dangerous shell command");
    process.exit(2);
  }
}
process.exit(0);
`;
      fs.writeFileSync(mockCliPath, mockCliSource, "utf8");

      const pluginSource = generateOpencodeV2GuardPlugin(mockCliPath, process.execPath);
      const pluginFile = path.join(tmpRoot, "asd-guard-v2.mjs");
      fs.writeFileSync(pluginFile, pluginSource, "utf8");

      const mod = (await import(pathToFileURL(pluginFile).href)) as {
        AsdV2PolicyGuardPlugin: {
          id: string;
          setup: (ctx: Record<string, unknown>) => Promise<() => void>;
        };
        default: {
          id: string;
          setup: (ctx: Record<string, unknown>) => Promise<() => void>;
        };
      };

      assert.equal(mod.default, mod.AsdV2PolicyGuardPlugin);
      assert.equal(mod.default.id, OPENCODE_V2_PLUGIN_ID);

      const toolHooks = new Map<string, (event: Record<string, unknown>) => unknown>();
      let capturedSignal: AbortSignal | undefined;
      const eventQueue: Array<Record<string, unknown>> = [];
      let wakeStream: (() => void) | null = null;
      let streamClosed = false;

      const pushEvent = (evt: Record<string, unknown>) => {
        eventQueue.push(evt);
        if (wakeStream) {
          const wake = wakeStream;
          wakeStream = null;
          wake();
        }
      };

      const mockCtx = {
        location: { directory: tmpRoot },
        tool: {
          hook: async (hookName: string, handler: (event: Record<string, unknown>) => unknown) => {
            toolHooks.set(hookName, handler);
          },
        },
        event: {
          subscribe: ({ signal }: { signal: AbortSignal }) => {
            capturedSignal = signal;
            signal.addEventListener("abort", () => {
              streamClosed = true;
              if (wakeStream) {
                const wake = wakeStream;
                wakeStream = null;
                wake();
              }
            });
            return {
              async *[Symbol.asyncIterator]() {
                while (!streamClosed && !signal.aborted) {
                  if (eventQueue.length > 0) {
                    yield eventQueue.shift()!;
                    continue;
                  }
                  await new Promise<void>((resolve) => {
                    wakeStream = resolve;
                  });
                }
              },
            };
          },
        },
      };

      cleanup = await mod.default.setup(mockCtx);
      assert.equal(typeof cleanup, "function");
      assert.ok(capturedSignal, "event.subscribe should receive an AbortSignal");
      assert.equal(capturedSignal.aborted, false);

      const executeBefore = toolHooks.get("execute.before");
      assert.ok(executeBefore, "execute.before hook should be registered");

      // (a) execute.before for `write` to `.asd/PLAN.md` -> throws denial Error
      assert.throws(
        () =>
          executeBefore({
            tool: "write",
            sessionID: "ses_v2_1",
            input: { filePath: ".asd/PLAN.md", content: "forbidden" },
          }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("protected .asd/ directory")
      );

      // (b) execute.before for V2 `shell` tool with dangerous command -> throws denial Error
      assert.throws(
        () =>
          executeBefore({
            tool: "shell",
            sessionID: "ses_v2_1",
            input: { command: "rm -rf /" },
          }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("Blocked dangerous shell command")
      );

      // (c) execute.before for allowed tool -> resolves cleanly
      await Promise.resolve(
        executeBefore({
          tool: "write",
          sessionID: "ses_v2_1",
          input: { filePath: "src/allowed.ts", content: "export const ok = true;\n" },
        })
      );

      // (d) event.subscribe emitting session.idle -> invokes stop hook
      pushEvent({
        type: "session.idle",
        properties: { sessionID: "ses_v2_1" },
      });

      const readInvocations = () => {
        if (!fs.existsSync(hookLogPath)) return [];
        const raw = fs.readFileSync(hookLogPath, "utf8").trim();
        if (!raw) return [];
        return raw.split(/\r?\n/).map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              payload: Record<string, unknown>;
            }
        );
      };

      await waitForCondition(() => readInvocations().length >= 4);

      const invocations = readInvocations();
      assert.equal(invocations.length, 4);

      assert.deepEqual(invocations[0]?.args, ["hook", "pre-tool-use", "--harness", "opencode"]);
      assert.deepEqual(invocations[0]?.payload, {
        tool_name: "write",
        tool_input: { filePath: ".asd/PLAN.md", content: "forbidden" },
        cwd: tmpRoot,
        session_id: "ses_v2_1",
      });

      assert.deepEqual(invocations[1]?.args, ["hook", "pre-tool-use", "--harness", "opencode"]);
      assert.deepEqual(invocations[1]?.payload, {
        tool_name: "shell",
        tool_input: { command: "rm -rf /" },
        cwd: tmpRoot,
        session_id: "ses_v2_1",
      });

      assert.deepEqual(invocations[2]?.args, ["hook", "pre-tool-use", "--harness", "opencode"]);
      assert.deepEqual(invocations[2]?.payload, {
        tool_name: "write",
        tool_input: { filePath: "src/allowed.ts", content: "export const ok = true;\n" },
        cwd: tmpRoot,
        session_id: "ses_v2_1",
      });

      assert.deepEqual(invocations[3]?.args, ["hook", "stop", "--harness", "opencode"]);
      assert.deepEqual(invocations[3]?.payload, {
        session_id: "ses_v2_1",
        cwd: tmpRoot,
      });

      // (e) calling returned cleanup() aborts the subscription AbortSignal
      cleanup();
      assert.equal(capturedSignal.aborted, true);
    } finally {
      cleanup?.();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("generateOpencodePluginForProfile & globalConfigTargets select V2 for 2.3.2 and V1 for 1.19.4 / unknown", () => {
    const v2Profile = buildOpenCodeCapabilityProfile({
      rawOutput: "opencode 2.3.2",
      version: "2.3.2",
      major: 2,
      pluginApi: "v2",
      source: "cli-probe",
    });
    const v1Profile = buildOpenCodeCapabilityProfile({
      rawOutput: "1.19.4",
      version: "1.19.4",
      major: 1,
      pluginApi: "v1",
      source: "cli-probe",
    });
    const unknownProfile = buildOpenCodeCapabilityProfile({
      rawOutput: null,
      version: null,
      major: null,
      pluginApi: "unknown",
      source: "fallback",
      degradedWarning: "OpenCode not found",
    });

    const v2Result = generateOpencodePluginForProfile(v2Profile, "/tmp/asd-cli.ts");
    assert.equal(v2Result.profile, "v2");
    assert.equal(v2Result.relativePath, OPENCODE_V2_PLUGIN_RELATIVE_PATH);
    assert.equal(v2Result.marker, OPENCODE_V2_PLUGIN_MARKER);
    assert.ok(v2Result.content.startsWith(OPENCODE_V2_PLUGIN_MARKER));

    const v1Result = generateOpencodePluginForProfile(v1Profile, "/tmp/asd-cli.ts");
    assert.equal(v1Result.profile, "v1");
    assert.equal(v1Result.relativePath, OPENCODE_V1_PLUGIN_RELATIVE_PATH);
    assert.equal(v1Result.marker, OPENCODE_V1_PLUGIN_MARKER);
    assert.ok(v1Result.content.startsWith(OPENCODE_V1_PLUGIN_MARKER));

    const unknownResult = generateOpencodePluginForProfile(unknownProfile, "/tmp/asd-cli.ts");
    assert.equal(unknownResult.profile, "v1");
    assert.equal(unknownResult.relativePath, OPENCODE_V1_PLUGIN_RELATIVE_PATH);
    assert.equal(unknownResult.marker, OPENCODE_V1_PLUGIN_MARKER);
    assert.ok(unknownResult.content.startsWith(OPENCODE_V1_PLUGIN_MARKER));

    const adapter = new OpencodeAdapter();
    const mockHome = path.join(os.tmpdir(), "asd-v2-targets-home");
    const v2Targets = adapter.globalConfigTargets(mockHome, v2Profile);
    assert.ok(
      v2Targets.includes(path.join(mockHome, ".config", "opencode", "plugins", "asd-guard", "index.js"))
    );
    assert.equal(
      v2Targets.includes(path.join(mockHome, ".config", "opencode", "plugin", "asd-guard.js")),
      false
    );

    const v1Targets = adapter.globalConfigTargets(mockHome, v1Profile);
    assert.ok(
      v1Targets.includes(path.join(mockHome, ".config", "opencode", "plugin", "asd-guard.js"))
    );
  });

  test("abortOpencodeSession POSTs to /api/session/<id>/interrupt for V2 and /session/<id>/abort for V1/default", () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; method?: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      const v2Profile = buildOpenCodeCapabilityProfile({
        rawOutput: "opencode 2.3.2",
        version: "2.3.2",
        major: 2,
        pluginApi: "v2",
        source: "cli-probe",
      });
      const v1Profile = buildOpenCodeCapabilityProfile({
        rawOutput: "1.19.4",
        version: "1.19.4",
        major: 1,
        pluginApi: "v1",
        source: "cli-probe",
      });

      const v2Controller = new AbortController();
      abortOpencodeSession({
        mode: "daemon-sse",
        abortController: v2Controller,
        serverUrl: "http://127.0.0.1:4096/",
        sessionId: "ses_v2_1",
        profile: v2Profile,
      });
      assert.equal(v2Controller.signal.aborted, true);

      abortOpencodeSession({
        mode: "daemon-sse",
        serverUrl: "http://127.0.0.1:4096",
        sessionId: "ses_v1_1",
        profile: v1Profile,
      });

      abortOpencodeSession({
        mode: "daemon-sse",
        serverUrl: "http://127.0.0.1:4096",
        sessionId: "ses_default_1",
      });

      assert.deepEqual(fetchCalls, [
        { url: "http://127.0.0.1:4096/api/session/ses_v2_1/interrupt", method: "POST" },
        { url: "http://127.0.0.1:4096/session/ses_v1_1/abort", method: "POST" },
        { url: "http://127.0.0.1:4096/session/ses_default_1/abort", method: "POST" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
