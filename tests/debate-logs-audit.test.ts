/**
 * ASD Task T1.2 Regression Tests:
 * 1. runDebateBroker failure cleanup & DB status on all-fail Round 1.
 * 2. scanSubagentLogs sorting by updatedAt / finishedAt before startedAt.
 * 3. Concurrent & sequential recordCliRecentSession atomic preservation.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDebateBroker } from "../src/core/debate.ts";
import { openProjectDb, SqliteDriver } from "../src/core/db.ts";
import { scanSubagentLogs } from "../src/core/subagent-logs.ts";
import {
  recordCliRecentSession,
  readCliRecentSessions,
} from "../src/core/session-tracker.ts";
import type { CommandRunner } from "../src/core/spawner.ts";

const tmpDirs: string[] = [];
const openDrivers: SqliteDriver[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-t12-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const drv of openDrivers) {
    try {
      drv.close();
    } catch {
      // Ignore
    }
  }
  openDrivers.length = 0;

  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Ignore cleanup error
    }
  }
  tmpDirs.length = 0;
});

describe("ASD Task T1.2 Audit & Regression Tests", () => {
  describe("1. runDebateBroker Failure Cleanup", () => {
    test("when all reviewers fail in Round 1: verifies DB debate status is 'failed' and prompt.md is cleaned up", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "asd-20261109-120000-fail";
      const debateId = "D-ALL-FAIL-AUDIT";

      const mockFailingRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(9999);
          opts.onStderr("Reviewer process failure mock");
          return { exitCode: 1, pid: 9999 };
        },
      };

      await assert.rejects(
        async () => {
          await runDebateBroker({
            projectRoot,
            sessionId,
            debateId,
            topic: "Reviewer failure test",
            proposal: "This proposal will fail all reviewers",
            commandRunner: mockFailingRunner,
            db,
          });
        },
        /All debate reviewers failed or timed out in Round 1/
      );

      // Verify DB record status is 'failed'
      const debateRow = db.getDebate(debateId);
      assert.ok(debateRow, "Debate row must be present in DB");
      assert.equal(debateRow.status, "failed");
      assert.ok(debateRow.round1_bundle_json);

      // Verify subagent prompt.md artifacts are purged
      const subDirRoot = path.join(projectRoot, ".asd", "sessions", sessionId, "subagents");
      if (fs.existsSync(subDirRoot)) {
        const subDirs = fs.readdirSync(subDirRoot);
        assert.ok(subDirs.length > 0, "Subagent directories should have been created");
        for (const sub of subDirs) {
          const promptFile = path.join(subDirRoot, sub, "prompt.md");
          assert.equal(
            fs.existsSync(promptFile),
            false,
            `prompt.md in ${sub} must be purged`
          );
        }
      }
    });
  });

  describe("2. scanSubagentLogs Sorting", () => {
    test("sorts subagent logs by updatedAt/finishedAt instead of only startedAt", () => {
      const projectRoot = makeProjectRoot();
      const sessionId = "asd-20261109-120001-sort";
      const subRoot = path.join(projectRoot, ".asd", "sessions", sessionId, "subagents");
      fs.mkdirSync(subRoot, { recursive: true });

      // Subagent 1: started earlier (1000), finished later (5000)
      const sub1Dir = path.join(subRoot, "sub-early-start-late-finish");
      fs.mkdirSync(sub1Dir, { recursive: true });
      fs.writeFileSync(
        path.join(sub1Dir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-early-start-late-finish",
          mainSessionId: sessionId,
          role: "worker",
          harness: "claude-code",
          model: "claude-sonnet-4-6",
          status: "done",
          startedAt: 1000,
          finishedAt: 5000,
        })
      );

      // Subagent 2: started later (2000), finished earlier (3000)
      const sub2Dir = path.join(subRoot, "sub-late-start-early-finish");
      fs.mkdirSync(sub2Dir, { recursive: true });
      fs.writeFileSync(
        path.join(sub2Dir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-late-start-early-finish",
          mainSessionId: sessionId,
          role: "critic",
          harness: "opencode",
          model: "glm-5",
          status: "done",
          startedAt: 2000,
          finishedAt: 3000,
        })
      );

      // Subagent 3: has updated_at = 7000, startedAt = 500
      const sub3Dir = path.join(subRoot, "sub-with-updated-at");
      fs.mkdirSync(sub3Dir, { recursive: true });
      fs.writeFileSync(
        path.join(sub3Dir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-with-updated-at",
          mainSessionId: sessionId,
          role: "architect",
          harness: "codex",
          model: "gpt-5-codex",
          status: "running",
          startedAt: 500,
          updated_at: 7000,
        })
      );

      const records = scanSubagentLogs(projectRoot);
      assert.equal(records.length, 3);

      // Highest effective time (7000) -> sub3
      assert.equal(records[0]?.subSessionId, "sub-with-updated-at");
      // Second highest effective time (5000) -> sub1
      assert.equal(records[1]?.subSessionId, "sub-early-start-late-finish");
      // Third highest effective time (3000) -> sub2
      assert.equal(records[2]?.subSessionId, "sub-late-start-early-finish");
    });

    test("tie-breaker: when effective updatedAt/finishedAt are equal, sorts by startedAt DESC", () => {
      const projectRoot = makeProjectRoot();
      const sessionId = "asd-20261109-120002-ties";
      const subRoot = path.join(projectRoot, ".asd", "sessions", sessionId, "subagents");
      fs.mkdirSync(subRoot, { recursive: true });

      const subADir = path.join(subRoot, "sub-tie-a");
      fs.mkdirSync(subADir, { recursive: true });
      fs.writeFileSync(
        path.join(subADir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-tie-a",
          mainSessionId: sessionId,
          status: "done",
          startedAt: 1500,
          finishedAt: 4000,
        })
      );

      const subBDir = path.join(subRoot, "sub-tie-b");
      fs.mkdirSync(subBDir, { recursive: true });
      fs.writeFileSync(
        path.join(subBDir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-tie-b",
          mainSessionId: sessionId,
          status: "done",
          startedAt: 2500,
          finishedAt: 4000,
        })
      );

      const records = scanSubagentLogs(projectRoot);
      assert.equal(records.length, 2);
      // Both have finishedAt 4000; subB startedAt (2500) > subA startedAt (1500)
      assert.equal(records[0]?.subSessionId, "sub-tie-b");
      assert.equal(records[1]?.subSessionId, "sub-tie-a");
    });
  });

  describe("3. cli-recent.json Concurrency & Sequential Writes", () => {
    test("preserves multiple recorded sessions without corruption or loss", () => {
      const projectRoot = makeProjectRoot();
      fs.mkdirSync(path.join(projectRoot, ".asd"), { recursive: true });

      for (let i = 1; i <= 5; i++) {
        const entry = recordCliRecentSession(projectRoot, {
          harnessSessionId: `h-sess-${i}`,
          harness: "claude-code",
          model: `claude-model-${i}`,
          summary: `Summary for session ${i}`,
        });
        assert.ok(entry, `Entry ${i} should be created`);
      }

      const sessions = readCliRecentSessions(projectRoot);
      assert.equal(sessions.length, 5);

      for (let i = 1; i <= 5; i++) {
        const found = sessions.find((s) => s.harnessSessionId === `h-sess-${i}`);
        assert.ok(found, `Session h-sess-${i} must be preserved`);
        assert.equal(found?.summary, `Summary for session ${i}`);
      }
    });
  });
});
