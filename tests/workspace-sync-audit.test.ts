/**
 * ASD Task T2.1 Regression Tests:
 * 1. hasLeakedSecrets avoids false positives on comments and kebab-case identifiers while catching real secrets.
 * 2. rollbackLightChanges normalizes Windows backslash paths when rolling back scoped files.
 * 3. syncPlanFromMd reconciles deleted tasks and preserves special failure statuses.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasLeakedSecrets, redactSecrets } from "../src/core/redact.ts";
import { prepareBaseline, rollbackLightChanges, runGit } from "../src/core/workspace.ts";
import { renderPlanMd, syncPlanFromMd } from "../src/core/render.ts";
import { openProjectDb, SqliteDriver } from "../src/core/db.ts";

const tmpDirs: string[] = [];
const openDrivers: SqliteDriver[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-t21-audit-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const drv of openDrivers) {
    try {
      drv.close();
    } catch {
      // ignore
    }
  }
  openDrivers.length = 0;
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
});

describe("Workspace, Secret Redaction & PLAN.md Sync Audit (T2.1)", () => {
  test("1. hasLeakedSecrets ignores comments and kebab-case identifiers while detecting real secrets", () => {
    const sampleSk = "sk-" + "proj-1234567890abcdefghij";
    const sampleAkia = "AKIA" + "IOSFODNN7EXAMPLE";

    // Comments with secret examples must not trigger false positive rollback
    assert.equal(
      hasLeakedSecrets(`// Example key: ${sampleSk}\n/* ${sampleAkia} */\nexport const x = 1;`),
      false
    );

    // Normal kebab-case identifier starting with sk- must not trigger false positive
    assert.equal(
      hasLeakedSecrets(`const id = "sk-notification-service-worker";`),
      false
    );

    // Real secret in code must be detected
    assert.equal(
      hasLeakedSecrets(`const apiKey = "${sampleSk}";`),
      true
    );
    assert.equal(
      hasLeakedSecrets(`const aws = "${sampleAkia}";`),
      true
    );

    // redactSecrets preserves template expressions and code identifiers in quoted patterns
    assert.equal(
      redactSecrets(`const msg = { token: "\${user.token}" };`),
      `const msg = { token: "\${user.token}" };`
    );
  });

  test("2. rollbackLightChanges normalizes Windows backslash paths and restores tracked/untracked scoped files", () => {
    const root = makeTempDir();
    prepareBaseline(root);

    const subDir = path.join(root, "src", "nested");
    fs.mkdirSync(subDir, { recursive: true });
    const trackedFile = path.join(subDir, "tracked.ts");
    const untouchedFile = path.join(subDir, "untouched.ts");
    fs.writeFileSync(trackedFile, "export const v = 1;\n", "utf8");
    fs.writeFileSync(untouchedFile, "export const u = 1;\n", "utf8");

    runGit(["add", "."], { cwd: root });
    runGit(["commit", "-m", "initial tracked files", "--no-verify"], { cwd: root });

    // Modify both files and add an untracked scoped file
    fs.writeFileSync(trackedFile, "export const v = 999;\n", "utf8");
    fs.writeFileSync(untouchedFile, "export const u = 999;\n", "utf8");
    const untrackedScoped = path.join(subDir, "new-file.ts");
    fs.writeFileSync(untrackedScoped, "export const n = 1;\n", "utf8");

    // Pass Windows-style backslash paths to rollbackLightChanges
    rollbackLightChanges(root, {
      files: ["src\\nested\\tracked.ts", "src\\nested\\new-file.ts"],
    });

    assert.equal(fs.readFileSync(trackedFile, "utf8").replace(/\r\n/g, "\n"), "export const v = 1;\n");
    assert.equal(fs.existsSync(untrackedScoped), false);
    // Untouched file outside rollback list remains modified
    assert.equal(fs.readFileSync(untouchedFile, "utf8").replace(/\r\n/g, "\n"), "export const u = 999;\n");
  });

  test("3. syncPlanFromMd deletes tasks removed from PLAN.md and preserves escalated/merge_conflict status", () => {
    const root = makeTempDir();
    const db = openProjectDb(root);
    openDrivers.push(db);

    const sessionId = "asd-20261109-130000-sync";
    const session = db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      memo: "Sync test",
    });

    db.upsertTasks(sessionId, [
      { taskId: "T1.1", turn: 1, title: "Keep escalated", targetFiles: ["src/a.ts"] },
      { taskId: "T1.2", turn: 1, title: "Delete me", targetFiles: ["src/b.ts"] },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "escalated");

    const planPath = path.join(root, ".asd", "PLAN.md");
    renderPlanMd(session, db.getSessionTasks(sessionId), planPath, { force: true });

    // User manually deletes T1.2 and leaves T1.1 with [~] without Status: line
    const editedMd = [
      "# ASD Execution Plan",
      `Session: ${sessionId}`,
      "",
      "## Turn 1",
      "- [~] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: Keep escalated (Files: src/a.ts)",
      "",
    ].join("\n");
    fs.writeFileSync(planPath, editedMd, "utf8");

    syncPlanFromMd(db, sessionId, planPath);
    const afterOneDelete = db.getSessionTasks(sessionId);
    assert.equal(afterOneDelete.length, 1);
    assert.equal(afterOneDelete[0]?.task_id, "T1.1");
    assert.equal(afterOneDelete[0]?.status, "escalated", "escalated status must not be overwritten with generic failed");
  });
});
