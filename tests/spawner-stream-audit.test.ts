/**
 * Regression and audit tests for spawner and stream safety:
 * 1. [SPAWN_ERROR] diagnostic tag on ENOENT spawn failure.
 * 2. [TIMEOUT] vs [IDLE_TIMEOUT] diagnostic tags on process timeout.
 * 3. CRLF split across chunk boundaries in createStreamParser.
 * 4. Windows .cmd fallback quoting with spaces when shell: true.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  executeHarnessProcess,
  killProcessTree,
  resolveSpawnCommand,
} from "../src/core/spawner.ts";
import { createStreamParser } from "../src/core/drivers.ts";

const tmpRoots: string[] = [];
const livePids: number[] = [];

function makeTempDir(prefix = "asd-spawner-audit-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const pid of livePids) {
    try {
      killProcessTree(pid);
    } catch {
      // ignore
    }
  }
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("Spawner & Stream Audit (T1.1)", () => {
  test("1. [SPAWN_ERROR] and [asd:spawn-error] output on command spawn failure (ENOENT)", async () => {
    const tmp = makeTempDir();
    const logPath = path.join(tmp, "output.log");
    let stderrOut = "";

    const res = await executeHarnessProcess({
      command: "non_existent_command_12345_xyz",
      args: ["--test"],
      cwd: tmp,
      env: { ...process.env } as Record<string, string>,
      harness: "codex",
      logPath,
      onOutput: (chunk) => {
        stderrOut += chunk;
      },
    });

    assert.equal(res.exitCode, -1);
    assert.equal(res.status, "failed");
    assert.ok(
      stderrOut.includes("[SPAWN_ERROR]"),
      `Expected stderr to include [SPAWN_ERROR], got: ${stderrOut}`
    );
    assert.ok(
      stderrOut.includes("[asd:spawn-error]"),
      `Expected stderr to include [asd:spawn-error], got: ${stderrOut}`
    );
  });

  test("2. [TIMEOUT] logged to output.log and onOutput when process exceeds hard timeout", async () => {
    const tmp = makeTempDir();
    const logPath = path.join(tmp, "timeout-output.log");
    let capturedOut = "";

    const res = await executeHarnessProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: tmp,
      env: { ...process.env } as Record<string, string>,
      harness: "claude-code",
      logPath,
      timeoutMs: 150,
      onOutput: (chunk) => {
        capturedOut += chunk;
      },
      onSpawn: (pid) => {
        if (pid > 0) livePids.push(pid);
      },
    });

    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutReason, "wall_clock");
    assert.equal(res.status, "failed");
    const logContent = fs.readFileSync(logPath, "utf8");
    assert.ok(
      logContent.includes("[TIMEOUT] Process exceeded timeout (150ms)"),
      `Expected log to include [TIMEOUT], got: ${logContent}`
    );
    assert.ok(
      capturedOut.includes("[TIMEOUT]"),
      `Expected captured output to include [TIMEOUT], got: ${capturedOut}`
    );
  });

  test("3. [IDLE_TIMEOUT] logged to output.log and onOutput when process stalls without output", async () => {
    const tmp = makeTempDir();
    const logPath = path.join(tmp, "idle-output.log");
    let capturedOut = "";

    const res = await executeHarnessProcess({
      command: "mock-cli",
      args: [],
      cwd: tmp,
      env: { ...process.env } as Record<string, string>,
      harness: "claude-code",
      logPath,
      timeoutMs: 10000,
      idleTimeoutMs: 100,
      onOutput: (chunk) => {
        capturedOut += chunk;
      },
      commandRunner: {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(54321);
          opts.onStdout("first-message\n");
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) return resolve();
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { exitCode: -1, pid: 54321 };
        },
      },
    });

    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutReason, "idle");
    assert.equal(res.status, "failed");
    const logContent = fs.readFileSync(logPath, "utf8");
    assert.ok(
      logContent.includes("first-message"),
      `Expected log to contain initial output, got: ${logContent}`
    );
    assert.ok(
      logContent.includes("[IDLE_TIMEOUT] Process produced no output for 100ms"),
      `Expected log to include [IDLE_TIMEOUT], got: ${logContent}`
    );
    assert.ok(
      capturedOut.includes("[IDLE_TIMEOUT]"),
      `Expected captured output to include [IDLE_TIMEOUT], got: ${capturedOut}`
    );
  });

  test("4. CRLF split across chunk boundaries in createStreamParser", () => {
    const parser = createStreamParser({ harness: "claude-code" });
    // Chunk 1 ends with \r
    const chunk1 = '{"type":"status","session_id":"abc-session-123"}\r';
    // Chunk 2 starts with \n
    const chunk2 = '\n{"type":"text","text":"hello world"}\r\n';

    const events1 = parser.pushChunk(chunk1);
    assert.equal(events1.length, 0, "No events should fire before \\n is encountered");

    const events2 = parser.pushChunk(chunk2);
    assert.equal(events2.length, 2, "Both lines should be parsed successfully");

    assert.equal(events2[0]?.type, "status");
    assert.equal(events2[0]?.harnessSessionId, "abc-session-123");

    assert.equal(events2[1]?.type, "text");
    assert.equal(events2[1]?.text, "hello world");
  });

  test("5. Windows .cmd fallback quotes paths and arguments with spaces when shell: true", () => {
    const tmp = makeTempDir();
    const spacedDir = path.join(tmp, "cli tools with space");
    fs.mkdirSync(spacedDir, { recursive: true });
    const cmdPath = path.join(spacedDir, "runner.cmd");
    // Non-npm batch script to trigger shell: true fallback
    fs.writeFileSync(cmdPath, "@echo off\r\necho %*\r\n", "utf8");

    if (process.platform === "win32") {
      const res = resolveSpawnCommand(cmdPath, ["arg one with space", "simpleArg", "\"already quoted\""]);
      assert.equal(res.shell, true);
      assert.equal(res.command, `"${cmdPath}"`);
      assert.deepEqual(res.args, [
        `"arg one with space"`,
        "simpleArg",
        `"already quoted"`,
      ]);
    } else {
      const res = resolveSpawnCommand(cmdPath, ["arg one with space", "simpleArg"]);
      assert.equal(res.shell, false);
      assert.equal(res.command, cmdPath);
    }
  });

  test("6. Windows .ps1 shim resolves via powershell -File with shell: false", () => {
    const tmp = makeTempDir();
    const ps1Path = path.join(tmp, "cursor-agent.ps1");
    fs.writeFileSync(ps1Path, "Write-Output 'ok'\r\n", "utf8");

    const res = resolveSpawnCommand(
      "cursor-agent",
      ["-p", "hello", "--force"],
      { PATH: tmp, Path: tmp },
      "win32"
    );
    assert.equal(res.shell, false);
    assert.ok(res.args.includes("-File"));
    assert.ok(res.args.includes(ps1Path));
    assert.equal(res.args.at(-1), "--force");
  });

  test("7. allowSlidingTimeout extends wall-clock timeout while output streams and caps at maxDurationMs", async () => {
    const tmp = makeTempDir();
    const logPath = path.join(tmp, "sliding-output.log");

    // Emits chunks every 80ms for 260ms total: exceeds initial timeoutMs (150ms)
    // but stays well within sliding window (150ms per chunk) and maxDurationMs (1000ms).
    const res = await executeHarnessProcess({
      command: "mock-sliding",
      args: [],
      cwd: tmp,
      env: { ...process.env } as Record<string, string>,
      harness: "opencode",
      logPath,
      timeoutMs: 150,
      maxDurationMs: 1000,
      idleTimeoutMs: 300,
      allowSlidingTimeout: true,
      commandRunner: {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(77777);
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 80));
            if (opts.signal?.aborted) return { exitCode: -1, pid: 77777 };
            opts.onStdout(`chunk-${i}\n`);
          }
          return { exitCode: 0, pid: 77777 };
        },
      },
    });

    assert.equal(res.timedOut, false);
    assert.equal(res.status, "done");
    assert.equal(res.exitCode, 0);
  });
});
