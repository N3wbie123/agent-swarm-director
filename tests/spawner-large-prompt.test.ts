/**
 * Tests for large prompt stdin offloading and spawn error handling.
 * Uses node:test and node:assert/strict.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  spawnSubagent,
  executeHarnessProcess,
  buildSpawnCommand,
  MAX_ARGV_CHARS,
  getHarnessStdinSpec,
} from "../src/core/spawner.ts";
import type { CommandRunner } from "../src/core/spawner.ts";
import type { SubagentSessionMeta } from "../src/core/types.ts";

const tmpRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-spawner-large-prompt-"));
  tmpRoots.push(dir);
  return dir;
}

function readMeta(metaPath: string): SubagentSessionMeta {
  return JSON.parse(fs.readFileSync(metaPath, "utf8")) as SubagentSessionMeta;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("spawner.ts - large prompt stdin offloading", () => {
  test("buildSpawnCommand: claude-code offloads to stdin when prompt > 1500 chars (legacy threshold)", () => {
    const prompt = "x".repeat(2000);
    const result = buildSpawnCommand("claude-code", "claude", ["-p", prompt, "--output-format", "json"], prompt);
    assert.ok(result.stdinPayload === prompt);
    assert.ok(result.closeStdinOnSpawn === true);
    assert.ok(!result.args.includes(prompt));
    assert.ok(result.args.includes("-p"));
  });

  test("buildSpawnCommand: claude-code does NOT offload when prompt <= 1500 chars", () => {
    const prompt = "x".repeat(1000);
    const result = buildSpawnCommand("claude-code", "claude", ["-p", prompt, "--output-format", "json"], prompt);
    assert.ok(result.stdinPayload === undefined);
    assert.ok(result.args.includes(prompt));
  });

  test("buildSpawnCommand: codex offloads to stdin when argv exceeds MAX_ARGV_CHARS", () => {
    const prompt = "x".repeat(MAX_ARGV_CHARS + 100);
    const result = buildSpawnCommand("codex", "codex", ["exec", prompt, "--json"], prompt);
    assert.ok(result.stdinPayload === prompt);
    assert.ok(result.closeStdinOnSpawn === true);
    assert.ok(result.args.includes("-"));
    assert.ok(!result.args.includes(prompt));
  });

  test("buildSpawnCommand: codex does NOT offload when argv under budget", () => {
    const prompt = "x".repeat(1000);
    const result = buildSpawnCommand("codex", "codex", ["exec", prompt, "--json"], prompt);
    assert.ok(result.stdinPayload === undefined);
    assert.ok(result.args.includes(prompt));
    assert.ok(!result.args.includes("-"));
  });

  test("buildSpawnCommand: antigravity throws when argv exceeds budget (no stdin support)", () => {
    const prompt = "x".repeat(MAX_ARGV_CHARS + 100);
    assert.throws(
      () => buildSpawnCommand("antigravity", "agy", ["-p", prompt, "--output-format", "json"], prompt),
      /does not support stdin prompt offloading/
    );
  });

  test("buildSpawnCommand: cursor throws when argv exceeds budget (no stdin support)", () => {
    const prompt = "x".repeat(MAX_ARGV_CHARS + 100);
    assert.throws(
      () => buildSpawnCommand("cursor", "agent", ["-p", prompt, "--force", "--output-format", "json"], prompt),
      /does not support stdin prompt offloading/
    );
  });

  test("buildSpawnCommand: opencode throws when argv exceeds budget (no stdin support)", () => {
    const prompt = "x".repeat(MAX_ARGV_CHARS + 100);
    assert.throws(
      () => buildSpawnCommand("opencode", "opencode", ["run", prompt, "--format", "json"], prompt),
      /does not support stdin prompt offloading/
    );
  });

  test("getHarnessStdinSpec returns correct specs for all harnesses", () => {
    assert.deepEqual(getHarnessStdinSpec("claude-code"), { stdinSupported: true, stdinMarker: null, promptArgFlag: "-p" });
    assert.deepEqual(getHarnessStdinSpec("codex"), { stdinSupported: true, stdinMarker: "-", promptArgFlag: "exec" });
    assert.deepEqual(getHarnessStdinSpec("antigravity"), { stdinSupported: false, stdinMarker: null, promptArgFlag: null });
    assert.deepEqual(getHarnessStdinSpec("cursor"), { stdinSupported: false, stdinMarker: null, promptArgFlag: null });
    assert.deepEqual(getHarnessStdinSpec("opencode"), { stdinSupported: false, stdinMarker: null, promptArgFlag: null });
  });
});

describe("spawner.ts - large prompt end-to-end with mock runner", () => {
  test("codex: >32k prompt spawns successfully via stdin path (mock runner)", async () => {
    const projectRoot = makeProjectRoot();
    const largePrompt = "x".repeat(40000);

    let capturedStdinPayload: string | undefined;
    let capturedArgs: string[] = [];

    const mockRunner: CommandRunner = {
      async run(cmd, args, opts) {
        capturedArgs = args;
        capturedStdinPayload = opts.stdinPayload;
        opts.onSpawn?.(1234);
        opts.onStdout("mock stdout\n");
        opts.onStderr("mock stderr\n");
        return { exitCode: 0, pid: 1234 };
      },
    };

    const baseArgs = ["exec", largePrompt, "--json"];
    const spec = buildSpawnCommand("codex", "codex", baseArgs, largePrompt);

    const result = await spawnSubagent({
      projectRoot,
      mainSessionId: "main-codex-large",
      subSessionId: "sub-codex-large",
      role: "worker",
      harness: "codex",
      model: "gpt-5",
      taskId: "T-LARGE-1",
      prompt: largePrompt,
      allowedFiles: [],
      command: spec.command,
      args: spec.args,
      stdinPayload: spec.stdinPayload,
      closeStdinOnSpawn: spec.closeStdinOnSpawn,
      commandRunner: mockRunner,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(capturedStdinPayload === largePrompt, "prompt should be passed via stdinPayload");
    assert.ok(capturedArgs.includes("-"), "args should contain '-' marker for stdin");
    assert.ok(!capturedArgs.includes(largePrompt), "args should not contain the large prompt");

    const meta = readMeta(result.metaPath);
    assert.equal(meta.status, "done");
    assert.equal(meta.harness, "codex");
  });

  test("claude-code: >1500 char prompt spawns successfully via stdin path (mock runner)", async () => {
    const projectRoot = makeProjectRoot();
    const largePrompt = "x".repeat(2000);

    let capturedStdinPayload: string | undefined;
    let capturedArgs: string[] = [];

    const mockRunner: CommandRunner = {
      async run(cmd, args, opts) {
        capturedArgs = args;
        capturedStdinPayload = opts.stdinPayload;
        opts.onSpawn?.(1234);
        opts.onStdout("mock stdout\n");
        opts.onStderr("mock stderr\n");
        return { exitCode: 0, pid: 1234 };
      },
    };

    const baseArgs = ["-p", largePrompt, "--output-format", "json"];
    const spec = buildSpawnCommand("claude-code", "claude", baseArgs, largePrompt);

    const result = await spawnSubagent({
      projectRoot,
      mainSessionId: "main-claude-large",
      subSessionId: "sub-claude-large",
      role: "worker",
      harness: "claude-code",
      model: "opus",
      taskId: "T-LARGE-2",
      prompt: largePrompt,
      allowedFiles: [],
      command: spec.command,
      args: spec.args,
      stdinPayload: spec.stdinPayload,
      closeStdinOnSpawn: spec.closeStdinOnSpawn,
      commandRunner: mockRunner,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(capturedStdinPayload === largePrompt, "prompt should be passed via stdinPayload");
    assert.ok(!capturedArgs.includes(largePrompt), "args should not contain the large prompt");
    assert.ok(capturedArgs.includes("-p"), "args should still contain -p flag");

    const meta = readMeta(result.metaPath);
    assert.equal(meta.status, "done");
    assert.equal(meta.harness, "claude-code");
  });

  test("antigravity: >32k prompt fails early with clear error (buildSpawnCommand throws)", () => {
    const largePrompt = "x".repeat(40000);
    const baseArgs = ["-p", largePrompt, "--output-format", "json"];

    assert.throws(
      () => buildSpawnCommand("antigravity", "agy", baseArgs, largePrompt),
      /does not support stdin prompt offloading/
    );
  });
});

describe("spawner.ts - spawn error handling (F2)", () => {
  test("executeHarnessProcess: synchronous spawn throw emits [SPAWN_ERROR] to stderr and resolves with exitCode -1", async () => {
    const projectRoot = makeProjectRoot();
    const logPath = path.join(projectRoot, "spawn-error.log");

    const failingRunner: CommandRunner = {
      async run() {
        throw new Error("ENOENT: no such file or directory, spawn 'nonexistent-binary-xyz'");
      }
    };

    const result = await executeHarnessProcess({
      command: "nonexistent-binary-xyz",
      args: ["arg1"],
      cwd: projectRoot,
      env: { ...process.env },
      harness: "opencode",
      logPath,
      commandRunner: failingRunner,
    });

    assert.equal(result.exitCode, -1);
    assert.equal(result.status, "failed");

    const log = fs.readFileSync(logPath, "utf8");
    assert.ok(log.includes("[SPAWN_ERROR]"), "log should contain SPAWN_ERROR marker");
    assert.ok(log.includes("ENOENT"), "log should contain error message");
    assert.ok(log.includes("nonexistent-binary-xyz"), "log should contain command name");
  });

  test("spawnSubagent: spawn failure produces [SPAWN_ERROR] in output.log and errorSummary in meta.json", async () => {
    const projectRoot = makeProjectRoot();

    const failingRunner: CommandRunner = {
      async run() {
        throw new Error("ENAMETOOLONG: argument list too long");
      }
    };

    const result = await spawnSubagent({
      projectRoot,
      mainSessionId: "main-error",
      subSessionId: "sub-error",
      role: "worker",
      harness: "opencode",
      model: "glm-5",
      taskId: "T-ERROR-1",
      prompt: "test prompt",
      allowedFiles: [],
      command: "fake-cmd",
      args: ["arg1"],
      commandRunner: failingRunner,
    });

    assert.equal(result.exitCode, -1);
    assert.equal(result.timedOut, false);

    const logPath = path.join(path.dirname(result.metaPath), "output.log");
    const log = fs.readFileSync(logPath, "utf8");
    assert.ok(log.includes("[SPAWN_ERROR]"), "output.log should contain SPAWN_ERROR marker");
    assert.ok(log.includes("ENAMETOOLONG"), "output.log should contain error details");

    const meta = readMeta(result.metaPath);
    assert.equal(meta.status, "failed");
    assert.ok(meta.errorSummary, "meta should have errorSummary");
    assert.ok(meta.errorSummary!.includes("[SPAWN_ERROR]"), "errorSummary should contain SPAWN_ERROR");
    assert.ok(meta.errorSummary!.includes("ENAMETOOLONG"), "errorSummary should contain error details");
  });

  test("executeHarnessProcess: runner rejection captures error in errorSummary", async () => {
    const projectRoot = makeProjectRoot();
    const logPath = path.join(projectRoot, "rejection-error.log");

    const rejectingRunner: CommandRunner = {
      async run() {
        return Promise.reject(new Error("Runner rejected: custom error"));
      }
    };

    const result = await executeHarnessProcess({
      command: "cmd",
      args: ["arg1"],
      cwd: projectRoot,
      env: { ...process.env },
      harness: "opencode",
      logPath,
      commandRunner: rejectingRunner,
    });

    assert.equal(result.exitCode, -1);
    assert.equal(result.status, "failed");
    assert.ok(result.errorSummary, "result should have errorSummary");
    assert.ok(result.errorSummary!.includes("Runner rejected"), "errorSummary should contain rejection reason");

    const log = fs.readFileSync(logPath, "utf8");
    assert.ok(log.includes("[SPAWN_ERROR]"), "log should contain SPAWN_ERROR marker");
    assert.ok(log.includes("Runner rejected"), "log should contain rejection reason");
  });
});

describe("spawner.ts - real spawn with large stdin payload (node child process)", () => {
  test("real spawn: large prompt passed via stdin to node child process", async () => {
    const projectRoot = makeProjectRoot();
    const logPath = path.join(projectRoot, "real-spawn.log");

    const scriptPath = path.join(projectRoot, "echo-stdin.mjs");
    fs.writeFileSync(
      scriptPath,
      `import { stdin } from "node:process";
const chunks = [];
for await (const chunk of stdin) {
  chunks.push(chunk);
}
console.log(Buffer.concat(chunks).toString("utf8"));`,
      "utf8"
    );

    const largePrompt = "x".repeat(40000);

    const result = await executeHarnessProcess({
      command: process.execPath,
      args: [scriptPath],
      cwd: projectRoot,
      env: { ...process.env },
      harness: "opencode",
      logPath,
      stdinPayload: largePrompt,
      closeStdinOnSpawn: true,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "done");

    const log = fs.readFileSync(logPath, "utf8");
    assert.ok(log.includes("x".repeat(100)), "stdin payload should reach child process");
    assert.ok(log.length >= largePrompt.length - 100, "most of the prompt should be in output");
  });
});