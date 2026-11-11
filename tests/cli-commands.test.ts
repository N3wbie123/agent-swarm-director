/**
 * CLI Parser, Hook Latency, Scope-Safe Clean, Handoff, Migrate & Update-Check Tests
 * (tests/cli-commands.test.ts)
 */

import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import {
  main,
  parseCliArgs,
  runAsdClean,
  runAsdHandoff,
  runAsdMigrate,
} from "../src/cli/index.ts";
import { checkForRemoteUpdate, isUpdateCheckDisabled } from "../src/core/config.ts";
import { openProjectDb } from "../src/core/db.ts";
import { runGit } from "../src/core/workspace.ts";

const cliPath = path.resolve(import.meta.dirname, "../src/cli/index.ts");

function initGitRepo(dir: string): void {
  runGit(["init"], { cwd: dir });
  runGit(["config", "user.name", "ASD Test"], { cwd: dir });
  runGit(["config", "user.email", "asd-test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n", "utf8");
  runGit(["add", "README.md"], { cwd: dir });
  runGit(["commit", "-m", "init"], { cwd: dir });
}

describe("CLI Parser, Hook Latency, Clean Safety, Handoff, Migrate & Update Check", () => {
  test("1. parseCliArgs resolves -p for ui vs resume/handoff and rejects invalid flags/numbers", () => {
    const uiPort = parseCliArgs(["ui", "-p", "4123"]);
    assert.equal(uiPort.command, "ui");
    assert.equal(uiPort.options.port, 4123);
    assert.equal(uiPort.flags.print, undefined);
    assert.equal(uiPort.parseError, undefined);

    const uiInlinePort = parseCliArgs(["ui", "-p=4999"]);
    assert.equal(uiInlinePort.options.port, 4999);
    assert.equal(uiInlinePort.parseError, undefined);

    const resumePrint = parseCliArgs(["resume", "-p"]);
    assert.equal(resumePrint.command, "resume");
    assert.equal(resumePrint.flags.print, true);
    assert.equal(resumePrint.options.port, undefined);

    const handoffPrint = parseCliArgs(["handoff", "-p"]);
    assert.equal(handoffPrint.command, "handoff");
    assert.equal(handoffPrint.flags.print, true);

    assert.ok(parseCliArgs(["ui", "-p", "abc"]).parseError?.includes("Invalid --port"));
    assert.ok(parseCliArgs(["ui", "--port", "70000"]).parseError?.includes("Invalid --port"));
    assert.ok(parseCliArgs(["dispatch", "--turn", "0"]).parseError?.includes("Invalid --turn"));
    assert.ok(parseCliArgs(["dispatch", "--turn", "nan"]).parseError?.includes("Invalid --turn"));
    assert.ok(parseCliArgs(["debate", "--count", "-2"]).parseError?.includes("Invalid --count"));
    assert.ok(parseCliArgs(["status", "--unknown-flag"]).parseError?.includes("Unknown flag: --unknown-flag"));
  });

  test("2. main() exits 1 on unknown flags or invalid numeric values", async () => {
    const code1 = await main(["status", "--not-a-real-flag"]);
    assert.equal(code1, 1);

    const code2 = await main(["ui", "-p", "not-a-port"]);
    assert.equal(code2, 1);
  });

  test("3. 'asd hook' with --payload or argv JSON skips 500ms stdin timeout (< 250ms subprocess)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-hook-fast-home-"));
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "asd-hook-fast-proj-"));
    try {
      const start = performance.now();
      // Spawn subprocess with an OPEN stdin pipe to verify readStdinAsync() 500ms timer is NOT awaited
      const elapsed = await new Promise<{ code: number; ms: number }>((resolve, reject) => {
        const child = child_process.spawn(
          process.execPath,
          [
            "--no-warnings",
            cliPath,
            "hook",
            "pre-tool-use",
            "--harness",
            "claude-code",
            "--project-root",
            tmpProj,
            "--home",
            tmpHome,
            "--payload",
            JSON.stringify({ tool_name: "Read", tool_input: { file_path: "README.md" } }),
          ],
          {
            cwd: tmpProj,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }
        );
        // Keep child.stdin open intentionally!
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("asd hook hung waiting on open stdin pipe despite --payload"));
        }, 5000);
        child.on("close", (code) => {
          clearTimeout(killTimer);
          child.stdin?.destroy();
          resolve({ code: code ?? 1, ms: performance.now() - start });
        });
      });

      assert.equal(elapsed.code, 0);
      const maxAllowedMs = process.platform === "win32" ? 2500 : 450;
      assert.ok(
        elapsed.ms < maxAllowedMs,
        `Expected fast hook exit without 500ms stdin wait, took ${elapsed.ms.toFixed(1)}ms`
      );

      // In-process latency check with positional JSON argv (< 50ms)
      const inProcStart = performance.now();
      const inProcCode = await main([
        "hook",
        "stop",
        "--harness",
        "codex",
        "--project-root",
        tmpProj,
        "--home",
        tmpHome,
        JSON.stringify({ session_id: "s1" }),
      ]);
      const inProcMs = performance.now() - inProcStart;
      assert.equal(inProcCode, 0);
      assert.ok(inProcMs < 50, `Expected in-process hook < 50ms, got ${inProcMs.toFixed(1)}ms`);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  test("4. 'asd clean' preserves other project sessions by default and purges orphans only with --purge-orphans", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-clean-scope-home-"));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), "asd-clean-projA-"));
    const missingProjB = path.join(tmpHome, "deleted-project-b");
    initGitRepo(projA);

    try {
      const db = openProjectDb(projA, tmpHome);
      db.createOrGetSession({
        sessionId: "sess-proj-a",
        projectRoot: projA,
        mainHarness: "codex",
      });
      db.createOrGetSession({
        sessionId: "sess-missing-b",
        projectRoot: missingProjB,
        mainHarness: "claude-code",
      });
      db.close();

      // Default clean: must NOT purge sess-missing-b
      const resDefault = runAsdClean({ projectRoot: projA, homeDir: tmpHome });
      assert.deepEqual(resDefault.purgedSessions, []);

      const dbCheck1 = openProjectDb(projA, tmpHome);
      assert.ok(dbCheck1.getSession("sess-missing-b"), "Other project session must be preserved without --purge-orphans");
      dbCheck1.close();

      // Explicit --purge-orphans: removes non-existent project session
      const resPurge = runAsdClean({
        projectRoot: projA,
        homeDir: tmpHome,
        purgeOrphans: true,
      });
      assert.ok(resPurge.purgedSessions?.includes("sess-missing-b"));

      const dbCheck2 = openProjectDb(projA, tmpHome);
      assert.equal(dbCheck2.getSession("sess-missing-b"), undefined);
      assert.ok(dbCheck2.getSession("sess-proj-a"));
      dbCheck2.close();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
    }
  });

  test("5. 'asd handoff' generates redacted handoff.md and supports --print", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-handoff-home-"));
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "asd-handoff-proj-"));
    initGitRepo(tmpProj);

    try {
      const db = openProjectDb(tmpProj, tmpHome);
      const dynSecret = ["sk-ant", "api03", "SecretTokenInSessionTitle123456"].join("-");
      db.createOrGetSession({
        sessionId: "asd-20261111-120000-hoff",
        projectRoot: tmpProj,
        mainHarness: "antigravity",
        harnessSessionId: "conv-hoff-1",
      });
      db.upsertTasks("asd-20261111-120000-hoff", [
        {
          taskId: "T1.1",
          turn: 1,
          title: `Rotate credential ${dynSecret}`,
          track: "LIGHT",
        },
      ]);
      db.close();

      const resPrint = runAsdHandoff({
        projectRoot: tmpProj,
        homeDir: tmpHome,
        writeFile: false,
      });
      assert.equal(resPrint.ok, true);
      assert.equal(resPrint.outputPath, null);
      assert.equal(fs.existsSync(path.join(tmpProj, "handoff.md")), false);
      assert.ok(resPrint.markdown.includes("asd-20261111-120000-hoff"));
      assert.equal(resPrint.markdown.includes(dynSecret), false, "Secrets must be redacted in handoff.md");

      const resWrite = runAsdHandoff({
        projectRoot: tmpProj,
        homeDir: tmpHome,
        outputPath: "docs/custom-handoff.md",
      });
      assert.ok(resWrite.outputPath && fs.existsSync(resWrite.outputPath));
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  test("6. 'asd migrate' imports legacy .asd/core.db and hashed state DBs into ~/.asd/state/core.db", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-migrate-home-"));
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "asd-migrate-proj-"));
    initGitRepo(tmpProj);

    try {
      // Seed legacy local <project>/.asd/core.db
      const legacyLocalPath = path.join(tmpProj, ".asd", "core.db");
      fs.mkdirSync(path.dirname(legacyLocalPath), { recursive: true });
      const legacyDb = new DatabaseSync(legacyLocalPath);
      legacyDb.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          main_harness TEXT NOT NULL,
          phase TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn INTEGER NOT NULL,
          title TEXT NOT NULL,
          track TEXT NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (session_id, task_id)
        );
      `);
      legacyDb
        .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)")
        .run("sess-legacy-local", tmpProj, "claude-code", "running", 1000, 2000);
      legacyDb
        .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)")
        .run("T1.1", "sess-legacy-local", 1, "Legacy task", "LIGHT", "done");
      legacyDb.close();

      // Seed legacy per-hash ~/.asd/state/abcd1234/core.db
      const hashedDbPath = path.join(tmpHome, ".asd", "state", "abcd1234", "core.db");
      fs.mkdirSync(path.dirname(hashedDbPath), { recursive: true });
      const hashedDb = new DatabaseSync(hashedDbPath);
      hashedDb.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          main_harness TEXT NOT NULL,
          phase TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      hashedDb
        .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)")
        .run("sess-legacy-hash", tmpProj, "codex", "done", 1500, 2500);
      hashedDb.close();

      const res = runAsdMigrate({
        projectRoot: tmpProj,
        homeDir: tmpHome,
        cleanLegacy: true,
      });
      assert.equal(res.migratedDatabases.length, 2);
      assert.equal(res.sessionsImported, 2);
      assert.equal(res.tasksImported, 1);
      assert.equal(fs.existsSync(legacyLocalPath), false);
      assert.equal(fs.existsSync(hashedDbPath), false);

      const globalDb = openProjectDb(tmpProj, tmpHome);
      assert.ok(globalDb.getSession("sess-legacy-local"));
      assert.ok(globalDb.getSession("sess-legacy-hash"));
      assert.equal(globalDb.getSessionTasks("sess-legacy-local").length, 1);
      globalDb.close();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  test("7. ASD_NO_UPDATE_CHECK=1 and --no-update-check skip remote fetch and suppress cached banner", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-noupdate-home-"));
    try {
      const stateDir = path.join(tmpHome, ".asd", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "update-check.json"),
        JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion: "99.0.0" }),
        "utf8"
      );

      const resDisabledFlag = await checkForRemoteUpdate({
        homeDir: tmpHome,
        disableUpdateCheck: true,
        remoteUrl: "http://127.0.0.1:1/unreachable",
      });
      assert.equal(resDisabledFlag.updateAvailable, false);
      assert.equal(resDisabledFlag.latestVersion, null);

      const prev = process.env.ASD_NO_UPDATE_CHECK;
      process.env.ASD_NO_UPDATE_CHECK = "1";
      try {
        assert.equal(isUpdateCheckDisabled(), true);
        const resEnv = await checkForRemoteUpdate({
          homeDir: tmpHome,
          force: true,
          remoteUrl: "http://127.0.0.1:1/unreachable",
        });
        assert.equal(resEnv.updateAvailable, false);
      } finally {
        if (prev === undefined) delete process.env.ASD_NO_UPDATE_CHECK;
        else process.env.ASD_NO_UPDATE_CHECK = prev;
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
