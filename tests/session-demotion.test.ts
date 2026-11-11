/**
 * Safe Interactive Session Demotion (`asd resume`) Tests (tests/session-demotion.test.ts)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
  main,
  spawnInteractiveResume,
  validateSafeResumeArgs,
} from "../src/cli/index.ts";
import { openProjectDb } from "../src/core/db.ts";
import { runGit } from "../src/core/workspace.ts";

describe("Safe Windows/POSIX Interactive Session Resume (`asd resume`)", () => {
  test("1. validateSafeResumeArgs rejects shell metacharacters and command injection payloads", () => {
    assert.equal(
      validateSafeResumeArgs("codex", ["resume", "thread-abc-123", "-m", "gpt-5.4"]).ok,
      true
    );
    assert.equal(
      validateSafeResumeArgs("claude", ["--resume", "sess_01HXYZ", "--model", "claude-sonnet-4-6"]).ok,
      true
    );

    const payloads = [
      ["resume", "id & calc.exe"],
      ["resume", "id | whoami"],
      ["resume", "id; rm -rf /"],
      ["resume", "id`id`"],
      ["resume", "$(whoami)"],
      ["resume", "%COMSPEC%"],
      ["resume", "id\nwhoami"],
      ["resume", 'id" --dangerously-skip-permissions'],
      ["resume", "id > pwned.txt"],
    ];
    for (const args of payloads) {
      const res = validateSafeResumeArgs("codex", args);
      assert.equal(res.ok, false, `Expected metacharacter rejection for ${JSON.stringify(args)}`);
    }
  });

  test("2. spawnInteractiveResume throws UNSAFE_RESUME_ARGS before spawning any process", () => {
    assert.throws(
      () => spawnInteractiveResume("codex", ["resume", "abc & calc.exe"], process.cwd(), "win32"),
      (err: Error & { code?: string }) => err.code === "UNSAFE_RESUME_ARGS"
    );
  });

  test("3. 'asd resume --json' rejects poisoned harness_session_id in DB with UNSAFE_RESUME_ARGS", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-resume-safe-home-"));
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "asd-resume-safe-proj-"));
    runGit(["init"], { cwd: tmpProj });

    try {
      const db = openProjectDb(tmpProj, tmpHome);
      db.createOrGetSession({
        sessionId: "asd-20261111-150000-pwn1",
        projectRoot: tmpProj,
        mainHarness: "codex",
        mainModel: "gpt-5.4",
        harnessSessionId: "thread-1 & calc.exe",
      });
      db.close();

      let capturedOut = "";
      const origLog = console.log;
      console.log = (...a: unknown[]) => {
        capturedOut += a.map(String).join(" ") + "\n";
      };
      let exitCode = 0;
      try {
        exitCode = await main([
          "resume",
          "--session",
          "asd-20261111-150000-pwn1",
          "--json",
          "--project-root",
          tmpProj,
          "--home",
          tmpHome,
        ]);
      } finally {
        console.log = origLog;
      }

      assert.equal(exitCode, 1);
      const parsed = JSON.parse(capturedOut.trim()) as { error: string; message: string };
      assert.equal(parsed.error, "UNSAFE_RESUME_ARGS");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});
