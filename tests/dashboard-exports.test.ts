import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { openProjectDb } from "../src/core/db.ts";
import {
  approvePendingTask,
  collectDashboardSnapshot,
  discoverHarnessModels,
  getModelsDiskCachePath,
  getWorktreeDiff,
  rejectPendingTask,
  saveSessionMemo,
} from "../src/index.ts";

function makeTempDir(prefix = "asd-dash-exports-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("T2.1: collectDashboardSnapshot populates worktreeStatuses without throwing ReferenceError when worktree_path exists", async () => {
  const projDir = makeTempDir("asd-wt-snap-proj-");
  const wtDir = makeTempDir("asd-wt-snap-wt-");

  try {
    child_process.execSync("git init", { cwd: projDir, stdio: "ignore" });
    child_process.execSync("git config user.name \"ASD Test\"", { cwd: projDir, stdio: "ignore" });
    child_process.execSync("git config user.email \"test@asd.local\"", { cwd: projDir, stdio: "ignore" });
    fs.writeFileSync(path.join(projDir, "README.md"), "# Project Root\n");
    child_process.execSync("git add . && git commit -m \"Initial commit\"", { cwd: projDir, stdio: "ignore" });

    child_process.execSync("git init", { cwd: wtDir, stdio: "ignore" });
    child_process.execSync("git config user.name \"ASD Test\"", { cwd: wtDir, stdio: "ignore" });
    child_process.execSync("git config user.email \"test@asd.local\"", { cwd: wtDir, stdio: "ignore" });
    fs.writeFileSync(path.join(wtDir, "worktree-file.txt"), "committed content\n");
    child_process.execSync("git add . && git commit -m \"Initial wt commit\"", { cwd: wtDir, stdio: "ignore" });

    fs.writeFileSync(path.join(wtDir, "worktree-file.txt"), "modified content\n");
    fs.writeFileSync(path.join(wtDir, "untracked.txt"), "new file\n");

    const asdDir = path.join(projDir, ".asd");
    fs.mkdirSync(asdDir, { recursive: true });
    const db = openProjectDb(projDir);
    const sessionId = "asd-20261108-010000-wt01";
    db.createOrGetSession({
      sessionId,
      projectRoot: projDir,
      mainHarness: "claude-code",
      memo: "Test Worktree Status",
    });

    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Worktree Task",
        track: "HEAVY",
        role: "worker",
        category: "general",
        difficulty: "medium",
        targetFiles: ["worktree-file.txt"],
      },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "running", {
      worktreePath: wtDir,
    });
    db.close();

    const snapshot = await collectDashboardSnapshot({
      projectRoot: projDir,
      skipCliSpawn: true,
    });

    assert.ok(snapshot, "Snapshot must be returned");
    assert.equal(snapshot.projectRoot, path.resolve(projDir));
    assert.equal(snapshot.session?.session_id, sessionId);
    assert.equal(snapshot.tasks.length, 1);

    const taskKey = `${sessionId}::T1.1`;
    assert.ok(snapshot.worktreeStatuses, "worktreeStatuses object must exist");
    assert.ok(snapshot.worktreeStatuses[taskKey], `worktreeStatuses must contain key ${taskKey}`);
    const statusLines = snapshot.worktreeStatuses[taskKey]!;
    assert.ok(statusLines.some((l) => l.includes("worktree-file.txt")));
    assert.ok(statusLines.some((l) => l.includes("untracked.txt")));
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
});

test("T2.1: public API exports across src/index.ts, models.ts, session-services.ts, dashboard.ts, and workspace.ts", async () => {
  assert.equal(typeof collectDashboardSnapshot, "function");
  assert.equal(typeof saveSessionMemo, "function");
  assert.equal(typeof discoverHarnessModels, "function");
  assert.equal(typeof getModelsDiskCachePath, "function");
  assert.equal(typeof getWorktreeDiff, "function");
  assert.equal(typeof approvePendingTask, "function");
  assert.equal(typeof rejectPendingTask, "function");

  const sessionServicesMod = await import("../src/core/session-services.ts");
  assert.equal(typeof sessionServicesMod.collectDashboardSnapshot, "function");
  assert.equal(typeof sessionServicesMod.saveSessionMemo, "function");
  assert.equal(typeof sessionServicesMod.buildPromptForTask, "function");

  const modelsMod = await import("../src/core/models.ts");
  assert.equal(typeof modelsMod.discoverHarnessModels, "function");
  assert.equal(typeof modelsMod.getModelsDiskCachePath, "function");

  const dashboardMod = await import("../src/cli/dashboard.ts");
  assert.equal(typeof dashboardMod.startDashboardServer, "function");
  assert.equal(typeof dashboardMod.collectDashboardSnapshot, "function");
  assert.equal(typeof dashboardMod.saveSessionMemo, "function");
});
