/**
 * ASD Fault-Tolerant Execution & Worktree Recovery Tests (tests/fault-tolerant-recovery.test.ts)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { openProjectDb } from "../src/core/db.ts";
import { attachDriver, setDriverHarnessSessionId } from "../src/core/drivers.ts";
import {
  cleanStaleWorktreeLock,
  createTaskWorktree,
  ensureGitUserIdentity,
  findSessionTaskCommitSha,
  prepareBaseline,
  recoverOrphanedTasks,
  resolveWorktreeGitDir,
  runGit,
} from "../src/core/workspace.ts";

function makeTempGitRepo(prefix = "asd-ftr-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

describe("HC-3: Git Commit Idempotency (baseSha..HEAD)", () => {
  test("findSessionTaskCommitSha only finds commits within baseSha..HEAD and ignores prior session commits", () => {
    const root = makeTempGitRepo("asd-hc3-");
    try {
      // 1. Commit from an earlier session with task T1.1
      fs.writeFileSync(path.join(root, "fileA.txt"), "old\n");
      runGit(["add", "fileA.txt"], { cwd: root });
      runGit(["commit", "-m", "asd(T1.1): Old task in prior session", "--no-verify"], { cwd: root });

      const newSessionBaseSha = runGit(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

      // In the new session, T1.1 has NOT been committed yet
      const foundPrior = findSessionTaskCommitSha(root, "T1.1", newSessionBaseSha);
      assert.strictEqual(foundPrior, null, "Must ignore commits prior to baseSha");

      // 2. Commit T1.1 in the current session
      fs.writeFileSync(path.join(root, "fileB.txt"), "new\n");
      runGit(["add", "fileB.txt"], { cwd: root });
      runGit(["commit", "-m", "asd(T1.1): New task in current session", "--no-verify"], { cwd: root });

      const foundCurrent = findSessionTaskCommitSha(root, "T1.1", newSessionBaseSha);
      assert.ok(foundCurrent, "Must find commit in current session");
      const currentHead = runGit(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
      assert.strictEqual(foundCurrent, currentHead);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recoverOrphanedTasks marks already-committed task as done instead of failed", () => {
    const root = makeTempGitRepo("asd-hc3-rec-");
    try {
      const db = openProjectDb(root);
      const sessionId = "asd-20261108-010000-hc3";
      db.createOrGetSession({
        sessionId,
        projectRoot: root,
        mainHarness: "claude-code",
      });

      // Commit T1.1 directly to main
      fs.writeFileSync(path.join(root, "work.txt"), "done\n");
      runGit(["add", "work.txt"], { cwd: root });
      runGit(["commit", "-m", "asd(T1.1): Done task", "--no-verify"], { cwd: root });

      db.upsertTasks(sessionId, [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Done task",
          role: "worker",
          targetFiles: ["work.txt"],
          dependsOn: [],
        },
      ]);
      db.updateTaskStatus(sessionId, "T1.1", "running", {
        subSessionId: "sub-1-T1_1",
      });

      // Subagent is dead
      const subDir = path.join(root, ".asd", "sessions", sessionId, "subagents", "sub-1-T1_1");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-1-T1_1",
          sessionId,
          taskId: "T1.1",
          pid: 999991,
          ownerPid: 999992,
          dispatchMode: "parallel_spawn",
          startedAt: Date.now() - 5000,
          status: "running",
        }),
        "utf8"
      );

      const recovered = recoverOrphanedTasks({ db, projectRoot: root, sessionId });
      assert.strictEqual(recovered.length, 1);
      assert.strictEqual(recovered[0]!.to, "done");
      assert.strictEqual(recovered[0]!.reason, "already_committed");

      const tAfter = db.getTask(sessionId, "T1.1")!;
      assert.strictEqual(tAfter.status, "done");
      assert.ok(tAfter.commit_sha);
      db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("HC-4: Worktree Auto-Promotion vs Escalation", () => {
  test("auto-promotes completed worktree with valid asd-report and passing verification", () => {
    const root = makeTempGitRepo("asd-hc4-promo-");
    try {
      const db = openProjectDb(root);
      const sessionId = "asd-20261108-020000-hc4";
      db.createOrGetSession({
        sessionId,
        projectRoot: root,
        mainHarness: "claude-code",
      });

      const wt = createTaskWorktree(root, 1, "T1.1");
      fs.writeFileSync(path.join(wt.wtPath, "feature.txt"), "feature code\n");

      db.upsertTasks(sessionId, [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Completed feature",
          role: "worker",
          targetFiles: ["feature.txt"],
          dependsOn: [],
          verifyCmd: 'node -e "process.exit(0)"',
        },
      ]);
      db.updateTaskStatus(sessionId, "T1.1", "running", {
        worktreePath: wt.wtPath,
        subSessionId: "sub-promo",
      });

      const subDir = path.join(root, ".asd", "sessions", sessionId, "subagents", "sub-promo");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-promo",
          sessionId,
          taskId: "T1.1",
          pid: 999991,
          ownerPid: 999992,
          dispatchMode: "parallel_spawn",
          startedAt: Date.now() - 5000,
          status: "running",
          exitCode: 0,
        }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(subDir, "output.log"),
        '```asd-report\n{\n  "summary": "feature completed",\n  "changed_files": ["feature.txt"],\n  "key_decisions": [],\n  "risks": []\n}\n```',
        "utf8"
      );

      const recovered = recoverOrphanedTasks({ db, projectRoot: root, sessionId });
      assert.strictEqual(recovered.length, 1);
      assert.strictEqual(recovered[0]!.to, "done");
      assert.strictEqual(recovered[0]!.reason, "worktree_promoted");

      const tAfter = db.getTask(sessionId, "T1.1")!;
      assert.strictEqual(tAfter.status, "done");
      assert.ok(fs.existsSync(path.join(root, "feature.txt")), "Promoted file must exist on main");
      db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("escalates and preserves worktree when verification fails", () => {
    const root = makeTempGitRepo("asd-hc4-esc-");
    try {
      const db = openProjectDb(root);
      const sessionId = "asd-20261108-030000-hc4";
      db.createOrGetSession({
        sessionId,
        projectRoot: root,
        mainHarness: "claude-code",
      });

      const wt = createTaskWorktree(root, 1, "T1.1");
      fs.writeFileSync(path.join(wt.wtPath, "feature.txt"), "feature code\n");

      db.upsertTasks(sessionId, [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Failing test feature",
          role: "worker",
          targetFiles: ["feature.txt"],
          dependsOn: [],
          verifyCmd: 'node -e "process.exit(1)"', // Verification FAILS
        },
      ]);
      db.updateTaskStatus(sessionId, "T1.1", "running", {
        worktreePath: wt.wtPath,
        subSessionId: "sub-esc",
      });

      const subDir = path.join(root, ".asd", "sessions", sessionId, "subagents", "sub-esc");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, "meta.json"),
        JSON.stringify({
          subSessionId: "sub-esc",
          sessionId,
          taskId: "T1.1",
          pid: 999991,
          ownerPid: 999992,
          dispatchMode: "parallel_spawn",
          startedAt: Date.now() - 5000,
          status: "running",
          exitCode: 0,
        }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(subDir, "output.log"),
        '```asd-report\n{\n  "summary": "feature done",\n  "changed_files": ["feature.txt"],\n  "key_decisions": [],\n  "risks": []\n}\n```',
        "utf8"
      );

      const recovered = recoverOrphanedTasks({ db, projectRoot: root, sessionId });
      assert.strictEqual(recovered.length, 1);
      assert.strictEqual(recovered[0]!.to, "escalated");
      assert.strictEqual(recovered[0]!.reason, "verification_failed_preserved");

      const tAfter = db.getTask(sessionId, "T1.1")!;
      assert.strictEqual(tAfter.status, "escalated");
      assert.ok(fs.existsSync(wt.wtPath), "Worktree MUST be preserved on disk");
      assert.ok(fs.existsSync(path.join(wt.wtPath, "feature.txt")));
      db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("HC-5: Worktree Git Pointer & Lock Cleanup", () => {
  test("resolves gitdir and cleans stale index.lock in worktrees", () => {
    const root = makeTempGitRepo("asd-hc5-");
    try {
      const wt = createTaskWorktree(root, 1, "T1.1");
      const gitDir = resolveWorktreeGitDir(wt.wtPath);
      assert.ok(gitDir, "Must resolve gitdir");
      assert.ok(fs.existsSync(gitDir));

      const lockPath = path.join(gitDir, "index.lock");
      fs.writeFileSync(lockPath, "lock\n");
      assert.ok(fs.existsSync(lockPath));

      const cleaned = cleanStaleWorktreeLock(wt.wtPath, 0);
      assert.strictEqual(cleaned, true);
      assert.strictEqual(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("HC-6: setDriverHarnessSessionId allowOverwrite Support", () => {
  test("throws when different id is set without allowOverwrite, and succeeds with allowOverwrite: true", () => {
    const root = makeTempGitRepo("asd-hc6-");
    try {
      const db = openProjectDb(root);
      const sessionId = "asd-20261108-040000-hc6";
      db.createOrGetSession({
        sessionId,
        projectRoot: root,
        mainHarness: "claude-code",
      });

      const attach = attachDriver(db, {
        projectRoot: root,
        sessionId,
        harness: "claude-code",
        source: "cli-asd",
      });

      // Initial set
      setDriverHarnessSessionId(db, {
        projectRoot: root,
        driverId: attach.driver.driver_id,
        harnessSessionId: "sess-1",
      });

      // Default call with different ID must throw
      assert.throws(() => {
        setDriverHarnessSessionId(db, {
          projectRoot: root,
          driverId: attach.driver.driver_id,
          harnessSessionId: "sess-2",
        });
      }, /already has harness_session_id/);

      // Call with allowOverwrite: true must succeed
      const updated = setDriverHarnessSessionId(db, {
        projectRoot: root,
        driverId: attach.driver.driver_id,
        harnessSessionId: "sess-2",
        allowOverwrite: true,
      });
      assert.strictEqual(updated.harness_session_id, "sess-2");
      db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
