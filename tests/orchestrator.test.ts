/**
 * ASD v2.2 MCP Core Server Comprehensive Test Suite (tests/mcp-server.test.ts).
 *
 * Verifies:
 * 1. Tool list & MCP initialization (tools/list has all 4 tools with accurate schemas).
 * 2. Subagent Shield Guard:
 *    - Rejects asd_plan, asd_dispatch, asd_verify, and asd_debate when ASD_SESSION_ROLE=subagent.
 *    - Allows tools/list for subagents.
 *    - Bypasses autoSync when role is subagent; runs onMainStart when role is main.
 * 3. asd_plan:
 *    - 'create': initializes session, writes main.json, writes PLAN.md, returns progressBoard.
 *    - 'update': updates task metadata and re-renders.
 *    - 'get': retrieves session, phase, tasks, and progressBoard.
 *    - 'sync_from_md': syncs manual PLAN.md edits into SQLite and bumps state_version.
 * 4. asd_dispatch:
 *    - mode: 'claim_only' transitions pending tasks to running and creates worktree for HEAVY.
 *    - mode: 'parallel_spawn' verifies upstream depends_on, injects upstream key_decisions & files,
 *      concurrently executes via CommandRunner, verifies & commits, updates PLAN.md.
 *    - Emits progressBoard in all responses.
 * 5. asd_verify:
 *    - LIGHT task: runs in-place verification & checkpoint commit.
 *    - HEAVY task: runs worktree verification & mutexed merge into main.
 *    - Resets no_progress_count to 0.
 *    - When all tasks complete, sets phase = 'done' and writes .asd/summary.md.
 * 6. asd_debate:
 *    - Delegates to debate broker and returns verdict, constraints, decisions, risks, and progressBoard.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsdOrchestrator, PLAN_SCHEMA_DEFINITION, handlePlan, handleDispatch, handleDebate, handleVerify, parseSubagentReport } from "../src/orchestrator/index.ts";
import { waitForAsyncDispatch } from "../src/core/subagent-control.ts";
import { main as cliMain } from "../src/cli/index.ts";
import { openProjectDb, type SqliteDriver } from "../src/core/db.ts";
import { ensureGitUserIdentity, prepareBaseline, runGit } from "../src/core/workspace.ts";
import type { CommandRunner } from "../src/core/spawner.ts";
import { ASD_VERSION, type AsdPlanOutput, type AsdDispatchOutput, type AsdVerifyOutput, type AsdDebateOutput, type DoneClaim } from "../src/core/types.ts";

const tmpDirs: string[] = [];
const openServers: AsdOrchestrator[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-mcp-test-"));
  tmpDirs.push(dir);
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

const origHomeDir = process.env.ASD_HOME_DIR;

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asd-mcp-home-"));
  tmpDirs.push(home);
  process.env.ASD_HOME_DIR = home;
});

afterEach(() => {
  for (const srv of openServers) {
    try {
      srv.close();
    } catch {
      // ignore
    }
  }
  openServers.length = 0;

  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
  delete process.env.ASD_SESSION_ROLE;
  if (origHomeDir === undefined) {
    delete process.env.ASD_HOME_DIR;
  } else {
    process.env.ASD_HOME_DIR = origHomeDir;
  }
});

describe("ASD Orchestrator (src/orchestrator/)", () => {
  describe("2. Subagent Isolation Guard", () => {
    test("rejects orchestration tools when sessionRole is 'subagent'", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({
        projectRoot,
        sessionRole: "subagent",
        autoSync: false,
      });
      openServers.push(server);

      // asd_plan must be rejected
      await assert.rejects(
        async () => {
          await server.handlePlan({ action: "create" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );

      // asd_dispatch must be rejected
      await assert.rejects(
        async () => {
          await server.handleDispatch({ sessionId: "s1" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );

      // asd_debate must be rejected
      await assert.rejects(
        async () => {
          await server.handleDebate({ sessionId: "s1", topic: "t", proposal: "p" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );

    });

    test("detects subagent via process.env.ASD_SESSION_ROLE = 'subagent'", async () => {
      process.env.ASD_SESSION_ROLE = "subagent";
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await assert.rejects(
        async () => {
          await server.handleDispatch({ sessionId: "test" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );
    });

    test("subagents can reach handleVerify without triggering the orchestration guard", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({
        projectRoot,
        sessionRole: "subagent",
        autoSync: false,
      });
      openServers.push(server);

      await assert.rejects(
        async () => {
          await server.handleVerify({
            sessionId: "missing",
            taskId: "T1.1",
            doneClaim: { summary: "ok", changed_files: [], key_decisions: [], risks: [] },
          });
        },
        (err: Error) => {
          assert.notEqual(err.message, "Subagents cannot invoke orchestration tools");
          assert.ok(err.message.includes("Session not found"));
          return true;
        }
      );
    });

    test("main session asd_verify is not blocked by the subagent guard", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({
        projectRoot,
        sessionRole: "main",
        autoSync: false,
      });
      openServers.push(server);

      // main sessions reach verify logic; a missing session throws "Session not found",
      // NOT the subagent guard rejection
      await assert.rejects(
        async () => {
          await server.handleVerify({
            sessionId: "missing",
            taskId: "T1.1",
            doneClaim: { summary: "ok", changed_files: [], key_decisions: [], risks: [] },
          });
        },
        (err: Error) => {
          assert.notEqual(err.message, "Subagents cannot invoke orchestration tools");
          assert.ok(err.message.includes("Session not found"));
          return true;
        }
      );
    });

    test("subagent role skips autoSync; main role invokes onMainStart", async () => {
      const projectRoot = makeProjectRoot();
      let mainStarted = false;

      // When subagent: onMainStart must NOT be called
      const subServer = new AsdOrchestrator({
        projectRoot,
        sessionRole: "subagent",
        onMainStart: () => {
          mainStarted = true;
        },
      });
      openServers.push(subServer);
      assert.equal(mainStarted, false, "Subagent must not run startup hook");

      // When main: onMainStart MUST be called
      const mainServer = new AsdOrchestrator({
        projectRoot,
        sessionRole: "main",
        onMainStart: () => {
          mainStarted = true;
        },
      });
      openServers.push(mainServer);
      assert.equal(mainStarted, true, "Main session must trigger onMainStart");
    });

    test("rejects direct handler calls, SDK exports, and CLI orchestration commands for subagents before any DB/disk mutation", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({
        projectRoot,
        sessionRole: "subagent",
        autoSync: false,
      });
      openServers.push(server);

      // 1. Direct server.handlePlan / handleDispatch / handleDebate calls with sessionRole: "subagent"
      await assert.rejects(
        async () => {
          await server.handlePlan({
            action: "create",
            sessionId: "subagent-direct-plan",
            tasks: [{ taskId: "T1.1", turn: 1, title: "Should not be created", targetFiles: ["a.ts"] }],
          });
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );
      await assert.rejects(
        async () => {
          await server.handleDispatch({ sessionId: "subagent-direct-plan" });
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );
      await assert.rejects(
        async () => {
          await server.handleDebate({ sessionId: "subagent-direct-plan", topic: "t", proposal: "p" });
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );

      // 2. Top-level SDK exports with sessionRole: "subagent"
      await assert.rejects(
        async () => {
          await handlePlan(
            {
              action: "create",
              sessionId: "subagent-sdk-plan",
              tasks: [{ taskId: "T1.1", turn: 1, title: "SDK blocked", targetFiles: ["a.ts"] }],
            },
            { projectRoot, sessionRole: "subagent" }
          );
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );
      await assert.rejects(
        async () => {
          await handleDispatch({ sessionId: "subagent-sdk-plan" }, { projectRoot, sessionRole: "subagent" });
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );
      await assert.rejects(
        async () => {
          await handleDebate(
            { sessionId: "subagent-sdk-plan", topic: "t", proposal: "p" },
            { projectRoot, sessionRole: "subagent" }
          );
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );

      // 3. process.env.ASD_SESSION_ROLE = "subagent" via SDK exports and CLI (src/cli/index.ts plan create)
      process.env.ASD_SESSION_ROLE = "subagent";
      await assert.rejects(
        async () => {
          await handlePlan(
            {
              action: "create",
              sessionId: "subagent-env-plan",
              tasks: [{ taskId: "T1.1", turn: 1, title: "Env blocked", targetFiles: ["a.ts"] }],
            },
            { projectRoot }
          );
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );
      await assert.rejects(
        async () => {
          await handleDispatch({ sessionId: "subagent-env-plan" }, { projectRoot });
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );
      await assert.rejects(
        async () => {
          await handleDebate({ sessionId: "subagent-env-plan", topic: "t", proposal: "p" }, { projectRoot });
        },
        { name: "Error", message: "Subagents cannot invoke orchestration tools" }
      );

      const capturedErr: string[] = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        capturedErr.push(args.map(String).join(" "));
      };
      let cliCode = 0;
      try {
        cliCode = await cliMain([
          "plan",
          "create",
          "--project-root",
          projectRoot,
          "--session",
          "subagent-cli-plan",
          "--tasks",
          JSON.stringify([{ taskId: "T1.1", turn: 1, title: "CLI blocked", targetFiles: ["a.ts"] }]),
        ]);
      } finally {
        console.error = origConsoleError;
      }
      assert.equal(cliCode, 1);
      assert.ok(capturedErr.join("\n").includes("Subagents cannot invoke orchestration tools"));

      // Verify NO session or task state was created or mutated in DB or disk
      const dbCheck = openProjectDb(projectRoot);
      assert.equal(dbCheck.getLatestSession(), undefined);
      assert.equal(dbCheck.getSession("subagent-direct-plan"), undefined);
      assert.equal(dbCheck.getSession("subagent-sdk-plan"), undefined);
      assert.equal(dbCheck.getSession("subagent-env-plan"), undefined);
      assert.equal(dbCheck.getSession("subagent-cli-plan"), undefined);
      dbCheck.close();
      assert.equal(fs.existsSync(path.join(projectRoot, ".asd", "PLAN.md")), false);
      assert.deepEqual(fs.readdirSync(path.join(projectRoot, ".asd", "sessions")), []);

      // 4. Verify handleVerify (and server.handleVerify) remains allowed for subagents
      await assert.rejects(
        async () => {
          await server.handleVerify({
            sessionId: "missing-session",
            taskId: "T1.1",
            doneClaim: { summary: "ok", changed_files: [], key_decisions: [], risks: [] },
          });
        },
        (err: Error) => {
          assert.notEqual(err.message, "Subagents cannot invoke orchestration tools");
          assert.ok(err.message.includes("Session not found"));
          return true;
        }
      );
      await assert.rejects(
        async () => {
          await handleVerify(
            {
              sessionId: "missing-session",
              taskId: "T1.1",
              doneClaim: { summary: "ok", changed_files: [], key_decisions: [], risks: [] },
            },
            { projectRoot, sessionRole: "subagent" }
          );
        },
        (err: Error) => {
          assert.notEqual(err.message, "Subagents cannot invoke orchestration tools");
          assert.ok(err.message.includes("Session not found"));
          return true;
        }
      );
    });
  });

  describe("3. asd_plan Tool", () => {
    test("action: 'create' creates session, writes main.json & PLAN.md, returns progressBoard", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      const resp = (await server.handlePlan({
        action: "create",
        sessionId: "session-create-1",
        mainHarness: "claude-code",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Implement auth module",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["src/auth.ts"],
            contextHint: "src/auth.ts:1-20",
            acceptance: "Must support JWT verification",
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "Heavy database migration",
            track: "HEAVY",
            role: "worker",
            category: "general",
            difficulty: "high",
            targetFiles: ["src/db/migrate.ts"],
          },
        ],
      })) as AsdPlanOutput;

      assert.equal(resp.sessionId, "session-create-1");
      assert.equal(resp.stateVersion, 1);
      assert.equal(resp.phase, "planning");
      assert.equal(resp.tasks.length, 2);
      assert.equal(resp.tasks[0]?.taskId, "T1.1");
      assert.equal(resp.tasks[0]?.track, "LIGHT");
      assert.equal(resp.tasks[1]?.taskId, "T1.2");
      assert.equal(resp.tasks[1]?.track, "HEAVY");

      // progressBoard check: MUST include ### 📊 ASD TODO Progress
      assert.ok(resp.progressBoard.includes("### 📊 ASD TODO Progress"));
      assert.ok(resp.progressBoard.includes("T1.1"));
      assert.ok(resp.progressBoard.includes("T1.2"));

      // Verify .asd/sessions/session-create-1/main.json
      const mainJsonPath = path.join(projectRoot, ".asd", "sessions", "session-create-1", "main.json");
      assert.ok(fs.existsSync(mainJsonPath));
      const mainMeta = JSON.parse(fs.readFileSync(mainJsonPath, "utf8"));
      assert.equal(mainMeta.sessionId, "session-create-1");
      assert.equal(mainMeta.roleType, "main");
      assert.equal(mainMeta.role, "director");
      assert.equal(mainMeta.phase, "planning");

      // Verify .asd/PLAN.md
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      assert.ok(fs.existsSync(planMdPath));
      const planContent = fs.readFileSync(planMdPath, "utf8");
      assert.ok(planContent.includes("T1.1"));
      assert.ok(planContent.includes("Implement auth module"));
      assert.ok(planContent.includes("T1.2"));
    });

    test("action: 'update' modifies task definitions in SQLite and updates PLAN.md", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      // Create initial plan
      await server.handlePlan({
        action: "create",
        sessionId: "session-update-1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Original title",
            targetFiles: ["src/a.ts"],
          },
        ],
      });

      // Update task
      const updated = (await server.handlePlan({
        action: "update",
        sessionId: "session-update-1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Updated title with more details",
            targetFiles: ["src/a.ts", "src/b.ts"],
            acceptance: "New acceptance",
          },
        ],
      })) as AsdPlanOutput;

      assert.equal(updated.tasks[0]?.title, "Updated title with more details");
      assert.deepEqual(updated.tasks[0]?.targetFiles, ["src/a.ts", "src/b.ts"]);
      assert.equal(updated.tasks[0]?.acceptance, "New acceptance");

      const planContent = fs.readFileSync(path.join(projectRoot, ".asd", "PLAN.md"), "utf8");
      assert.ok(planContent.includes("Updated title with more details"));
    });

    test("action: 'get' retrieves current session state", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "session-get-1",
        tasks: [{ taskId: "T1.1", turn: 1, title: "Task 1", targetFiles: ["a.ts"] }],
      });

      const getResp = (await server.handlePlan({
        action: "get",
        sessionId: "session-get-1",
      })) as AsdPlanOutput;

      assert.equal(getResp.sessionId, "session-get-1");
      assert.equal(getResp.tasks.length, 1);
      assert.equal(getResp.tasks[0]?.taskId, "T1.1");
      assert.ok(getResp.progressBoard.includes("### 📊 ASD TODO Progress"));
    });

    test("action: 'sync_from_md' syncs manual checkbox and title edits from PLAN.md to SQLite", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "session-sync-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Task to complete manually", targetFiles: ["src/a.ts"] },
        ],
      });

      // Manually edit PLAN.md to mark task done: - [x] **T1.1** ...
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      let planContent = fs.readFileSync(planMdPath, "utf8");
      planContent = planContent.replace("- [ ] **T1.1**", "- [x] **T1.1**");
      fs.writeFileSync(planMdPath, planContent, "utf8");

      // sync_from_md
      const syncResp = (await server.handlePlan({
        action: "sync_from_md",
        sessionId: "session-sync-1",
      })) as AsdPlanOutput;

      assert.equal(syncResp.tasks[0]?.status, "done");
      assert.equal(syncResp.stateVersion, 2); // stateVersion incremented
      assert.ok(syncResp.progressBoard.includes("done"));
    });

    test("implicit 'create' never mutates a completed latest session", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "sess-guard-done",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Original done work", track: "LIGHT", targetFiles: ["a.ts"] },
        ],
      });
      const db = openProjectDb(projectRoot);
      db.updateSessionPhase("sess-guard-done", "done");
      db.close();

      const resp = (await server.handlePlan({
        action: "create",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Fresh probe work", track: "HEAVY", targetFiles: ["b.ts"] },
        ],
      })) as AsdPlanOutput;

      assert.notEqual(resp.sessionId, "sess-guard-done");
      const dbAfter = openProjectDb(projectRoot);
      const oldTask = dbAfter.getTask("sess-guard-done", "T1.1");
      assert.equal(oldTask?.title, "Original done work");
      const newSession = dbAfter.getSession(resp.sessionId);
      assert.ok(newSession);
      assert.notEqual(newSession.phase, "done");
      dbAfter.close();
    });

    test("action: 'get' does not overwrite manual edits in .asd/PLAN.md or mutate DB/main.json (F04)", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "sess-readonly-get",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Original Task Title", track: "LIGHT", targetFiles: ["src/a.ts"] },
        ],
      });

      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      const mainJsonPath = path.join(projectRoot, ".asd", "sessions", "sess-readonly-get", "main.json");
      const originalMainJson = fs.readFileSync(mainJsonPath, "utf8");
      fs.writeFileSync(mainJsonPath, '{"sentinel":true}\n', "utf8");

      const manualEditContent = fs
        .readFileSync(planMdPath, "utf8")
        .replace("Original Task Title", "Manually Edited Title In Markdown");
      fs.writeFileSync(planMdPath, manualEditContent, "utf8");

      const getResp = (await server.handlePlan({
        action: "get",
      })) as AsdPlanOutput;

      assert.equal(getResp.sessionId, "sess-readonly-get");
      assert.equal(getResp.stateVersion, 1);
      assert.equal(getResp.tasks[0]?.title, "Original Task Title");
      // Manual edit in PLAN.md must still be intact before sync_from_md!
      assert.equal(fs.readFileSync(planMdPath, "utf8"), manualEditContent);
      // main.json was not overwritten by get
      assert.equal(fs.readFileSync(mainJsonPath, "utf8"), '{"sentinel":true}\n');
      fs.writeFileSync(mainJsonPath, originalMainJson, "utf8");

      // Now sync_from_md picks up the preserved manual edit
      const syncResp = (await server.handlePlan({
        action: "sync_from_md",
      })) as AsdPlanOutput;
      assert.equal(syncResp.tasks[0]?.title, "Manually Edited Title In Markdown");
      assert.equal(syncResp.stateVersion, 2);
    });
  });

  describe("4. asd_dispatch Tool", () => {
    test("mode: 'claim_only' claims pending tasks, creates worktree for HEAVY, updates PLAN.md", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "dispatch-claim-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Light Worker", track: "LIGHT", targetFiles: ["light.ts"] },
          { taskId: "T1.2", turn: 1, title: "Heavy Worker", track: "HEAVY", targetFiles: ["heavy.ts"] },
        ],
      });

      const dispatchResp = (await server.handleDispatch({
        sessionId: "dispatch-claim-1",
        turn: 1,
        mode: "claim_only",
      })) as AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] };

      assert.equal(dispatchResp.sessionId, "dispatch-claim-1");
      assert.equal(dispatchResp.turn, 1);
      assert.equal(dispatchResp.results.length, 2);
      assert.deepEqual(dispatchResp.dispatchedTasks, dispatchResp.results);

      // Status transitioned to running
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "running");
      assert.equal(dispatchResp.results[1]?.taskId, "T1.2");
      assert.equal(dispatchResp.results[1]?.status, "running");

      // HEAVY task worktree created
      const wtDir = path.join(projectRoot, ".asd", "wt", "1-T1.2");
      assert.ok(fs.existsSync(wtDir), "HEAVY task worktree must exist");

      // Progress board emitted
      assert.ok(dispatchResp.progressBoard.includes("### 📊 ASD TODO Progress"));
      assert.ok(dispatchResp.progressBoard.includes("running"));
    });

    test("verifies upstream depends_on and blocks dispatch when dependencies are unfinished", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "dispatch-dep-test",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Upstream Task", track: "LIGHT", targetFiles: ["a.ts"] },
          {
            taskId: "T2.1",
            turn: 2,
            title: "Downstream Task",
            track: "LIGHT",
            dependsOn: ["T1.1"],
            targetFiles: ["b.ts"],
          },
        ],
      });

      // Try to dispatch Turn 2 while Turn 1 is still pending
      const resp = (await server.handleDispatch({
        sessionId: "dispatch-dep-test",
        turn: 2,
        mode: "claim_only",
      })) as AsdDispatchOutput;

      assert.equal(resp.results.length, 1);
      assert.ok(resp.results[0]?.error?.includes("Upstream dependencies not satisfied: T1.1"));
      assert.equal(resp.results[0]?.status, "pending");
    });

    test("mode: 'parallel_spawn' executes tasks via CommandRunner, verifies & merges", async () => {
      const projectRoot = makeProjectRoot();
      const executedCommands: string[] = [];

      // Mock CommandRunner that writes target files upon spawn
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          executedCommands.push(`${cmd} ${args.join(" ")}`);
          opts.onSpawn?.(9999);

          // Simulate worker modifying target file in its cwd
          const targetFile = path.join(opts.cwd ?? projectRoot, "hello.ts");
          fs.writeFileSync(targetFile, "export const hello = 'world';\n", "utf8");

          opts.onStdout("Task completed successfully\n");
          return { exitCode: 0, pid: 9999 };
        },
      };

      const server = new AsdOrchestrator({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "dispatch-spawn-1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Build widget",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["hello.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleDispatch({
        sessionId: "dispatch-spawn-1",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] };

      assert.equal(dispatchResp.results.length, 1);
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "done");
      assert.ok(dispatchResp.results[0]?.commitSha, "Commit SHA must be recorded");
      assert.ok(dispatchResp.progressBoard.includes("### 📊 ASD TODO Progress"));
      assert.ok(dispatchResp.progressBoard.includes("done"));

      // Subagent session directory and prompt.md written
      const subSessionDir = path.join(
        projectRoot,
        ".asd",
        "sessions",
        "dispatch-spawn-1",
        "subagents"
      );
      assert.ok(fs.existsSync(subSessionDir));
      const subDirs = fs.readdirSync(subSessionDir);
      assert.ok(subDirs.length > 0);
      assert.ok(!fs.existsSync(path.join(subSessionDir, subDirs[0]!, "prompt.md")), "CR-09: prompt.md is purged when parallel_spawn task reaches done");
      assert.ok(fs.existsSync(path.join(subSessionDir, subDirs[0]!, "meta.json")));
    });

    test("default mode (omitted): LIGHT tasks claim_only on mainHarness without external CLI spawn", async () => {
      const projectRoot = makeProjectRoot();
      let spawnedCount = 0;
      const mockRunner: CommandRunner = {
        async run() {
          spawnedCount++;
          return { exitCode: 0, pid: 1111 };
        },
      };

      const server = new AsdOrchestrator({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "dispatch-light-default",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Architect LIGHT task in current harness",
            track: "LIGHT",
            role: "architect",
            category: "general",
            difficulty: "high",
            targetFiles: ["light-arch.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleDispatch({
        sessionId: "dispatch-light-default",
        turn: 1,
      })) as AsdDispatchOutput;

      assert.equal(spawnedCount, 0, "LIGHT task must not spawn external CLI by default");
      assert.equal(dispatchResp.results.length, 1);
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "running");
      assert.equal(dispatchResp.results[0]?.harness, "opencode");
      assert.ok(dispatchResp.progressBoard.includes("(Turn 1, `LIGHT`, running)"), "LIGHT task in progressBoard must display `LIGHT` instead of @harness/model");
      assert.equal(fs.existsSync(path.join(projectRoot, ".asd", "sessions", "dispatch-light-default", "subagents")), false, "LIGHT claim_only must not create fake subagents/ directory");
    });

    test("parallel_spawn automatically steps through same-harness & cross-harness fallbacks on rate-limit or network error", async () => {
      const projectRoot = makeProjectRoot();
      // Write a custom project routing.jsonc with multiple models on opencode in fallbacks
      const asdDir = path.join(projectRoot, ".asd");
      fs.mkdirSync(asdDir, { recursive: true });
      fs.writeFileSync(
        path.join(asdDir, "routing.jsonc"),
        JSON.stringify(
          {
            version: "2.2.0",
            agents: {
              critic: {
                harness: "opencode",
                model: "glm-5",
                modelFamily: "glm",
                fallbacks: [
                  { harness: "opencode", model: "deepseek-r1", modelFamily: "deepseek" },
                  { harness: "opencode", model: "qwen-2.5-coder", modelFamily: "qwen" },
                ],
              },
              worker: {
                harness: "opencode",
                model: "glm-5",
                modelFamily: "glm",
                fallbacks: [],
              },
            },
            categories: {
              medium: {
                harness: "opencode",
                model: "glm-5",
                modelFamily: "glm",
                fallbacks: [],
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const triedModels: string[] = [];
      const mockRunner: CommandRunner = {
        async run(_cmd, args, opts) {
          const modelIdx = args.indexOf("--model");
          const model = modelIdx !== -1 ? args[modelIdx + 1] ?? "" : "";
          triedModels.push(model);
          opts.onSpawn?.(8888);

          // Simulate 1st model (glm-5) failing with 429 Rate Limit, 2nd model (deepseek-r1) failing with network error,
          // and 3rd model (qwen-2.5-coder) succeeding!
          if (model === "glm-5") {
            opts.onStderr("Error: 429 Too Many Requests - rate limit exceeded\n");
            return { exitCode: 1, pid: 8888 };
          }
          if (model === "deepseek-r1") {
            opts.onStderr("Error: ECONNRESET network error\n");
            return { exitCode: 1, pid: 8888 };
          }

          fs.writeFileSync(path.join(opts.cwd ?? projectRoot, "fallback-ok.ts"), "export const ok = true;\n", "utf8");
          opts.onStdout("Done with qwen-2.5-coder\n");
          return { exitCode: 0, pid: 8888 };
        },
      };

      const server = new AsdOrchestrator({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "dispatch-fb-chain",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task with multi-model fallback on same harness",
            track: "LIGHT",
            role: "critic",
            category: "general",
            difficulty: "medium",
            targetFiles: ["fallback-ok.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleDispatch({
        sessionId: "dispatch-fb-chain",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput;

      assert.deepEqual(triedModels, ["glm-5", "deepseek-r1", "qwen-2.5-coder"]);
      assert.equal(dispatchResp.results[0]?.status, "done");
      assert.equal(dispatchResp.results[0]?.harness, "opencode");
      assert.equal(dispatchResp.results[0]?.model, "qwen-2.5-coder");
    });

    test("parallel_spawn never marks task or session done when runner fails on all attempts (F01)", async () => {
      const projectRoot = makeProjectRoot();
      // Write routing config with no extra fallbacks so each escalation attempt is 1 spawn
      const asdDir = path.join(projectRoot, ".asd");
      fs.mkdirSync(asdDir, { recursive: true });
      fs.writeFileSync(
        path.join(asdDir, "routing.jsonc"),
        JSON.stringify(
          {
            version: "2.2.0",
            agents: {
              worker: { harness: "opencode", model: "glm-5", modelFamily: "glm", fallbacks: [] },
              architect: { harness: "claude-code", model: "claude-opus-4-6", modelFamily: "claude", fallbacks: [] },
            },
            categories: {
              medium: { harness: "opencode", model: "glm-5", modelFamily: "glm", fallbacks: [] },
              critical: { harness: "claude-code", model: "claude-opus-4-6", modelFamily: "claude", fallbacks: [] },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      let spawnCalls = 0;
      const mockRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          spawnCalls++;
          opts.onSpawn?.(4444 + spawnCalls);
          // Simulate partial broken write in LIGHT task before crashing with exitCode 1
          if (opts.cwd) {
            fs.writeFileSync(path.join(opts.cwd, "broken.ts"), `partial attempt ${spawnCalls}\n`, "utf8");
          }
          opts.onStderr("Fatal error: runner crashed\n");
          return { exitCode: 1, pid: 4444 + spawnCalls };
        },
      };

      const server = new AsdOrchestrator({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "dispatch-fail-f01",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task with crashing runner and no verifyCmd",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["broken.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleDispatch({
        sessionId: "dispatch-fail-f01",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput;

      // Must escalate across 3 attempts and end in status: "failed"
      assert.equal(spawnCalls, 3);
      assert.equal(dispatchResp.results.length, 1);
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "failed");
      assert.ok(dispatchResp.results[0]?.error?.includes("Subagent exited with code 1"));

      // Partial broken writes in LIGHT scope must be rolled back
      assert.equal(fs.existsSync(path.join(projectRoot, "broken.ts")), false);

      // DB task status must be "failed" with 3 attempts, and session phase must NOT be "done"
      const db = openProjectDb(projectRoot);
      const taskRow = db.getTask("dispatch-fail-f01", "T1.1");
      const sessionRow = db.getSession("dispatch-fail-f01");
      assert.equal(taskRow?.status, "failed");
      assert.equal(taskRow?.attempts, 3);
      assert.notEqual(sessionRow?.phase, "done");
      db.close();
    });

    test("parallel_spawn marks task failed and does not complete session on timeout or AbortController cancellation (F01)", async () => {
      const projectRoot = makeProjectRoot();
      const asdDir = path.join(projectRoot, ".asd");
      fs.mkdirSync(asdDir, { recursive: true });
      fs.writeFileSync(
        path.join(asdDir, "routing.jsonc"),
        JSON.stringify(
          {
            version: "2.2.0",
            agents: {
              worker: { harness: "opencode", model: "glm-5", modelFamily: "glm", fallbacks: [] },
              architect: { harness: "claude-code", model: "claude-opus-4-6", modelFamily: "claude", fallbacks: [] },
            },
            categories: {
              medium: { harness: "opencode", model: "glm-5", modelFamily: "glm", fallbacks: [] },
              critical: { harness: "claude-code", model: "claude-opus-4-6", modelFamily: "claude", fallbacks: [] },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      // Part A: AbortSignal cancellation stops immediately without marking done
      const abortController = new AbortController();
      let abortSpawnCalls = 0;
      const abortRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          abortSpawnCalls++;
          opts.onSpawn?.(5555);
          abortController.abort();
          return { exitCode: -1, pid: 5555 };
        },
      };

      const abortServer = new AsdOrchestrator({
        projectRoot,
        commandRunner: abortRunner,
        autoSync: false,
      });
      openServers.push(abortServer);

      await abortServer.handlePlan({
        action: "create",
        sessionId: "dispatch-abort-f01",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task cancelled via AbortController",
            track: "HEAVY",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["aborted.ts"],
          },
        ],
      });

      const abortResp = await abortServer.handleDispatch(
        {
          sessionId: "dispatch-abort-f01",
          turn: 1,
          mode: "parallel_spawn",
        },
        abortController.signal
      );

      assert.equal(abortSpawnCalls, 1, "Aborted task must not continue escalating");
      assert.equal(abortResp.results[0]?.status, "failed");
      assert.ok(abortResp.results[0]?.error?.includes("aborted"));

      // Worktree must be cleaned up on HEAVY abort
      assert.equal(fs.existsSync(path.join(projectRoot, ".asd", "wt", "1-T1.1")), false);

      const db1 = openProjectDb(projectRoot);
      assert.equal(db1.getTask("dispatch-abort-f01", "T1.1")?.status, "failed");
      assert.notEqual(db1.getSession("dispatch-abort-f01")?.phase, "done");
      db1.close();

      // Part B: Timeout (via ASD_SPAWN_TIMEOUT_MS) marks task failed and never done
      const prevTimeout = process.env.ASD_SPAWN_TIMEOUT_MS;
      process.env.ASD_SPAWN_TIMEOUT_MS = "30";
      try {
        const timeoutRunner: CommandRunner = {
          async run(_cmd, _args, opts) {
            opts.onSpawn?.(6666);
            return await new Promise<{ exitCode: number; pid: number }>((resolve) => {
              const t = setTimeout(() => resolve({ exitCode: 0, pid: 6666 }), 5000);
              t.unref?.();
              opts.signal?.addEventListener("abort", () => {
                clearTimeout(t);
                resolve({ exitCode: 1, pid: 6666 });
              });
            });
          },
        };

        const timeoutServer = new AsdOrchestrator({
          projectRoot,
          commandRunner: timeoutRunner,
          autoSync: false,
        });
        openServers.push(timeoutServer);

        await timeoutServer.handlePlan({
          action: "create",
          sessionId: "dispatch-timeout-f01",
          mainHarness: "opencode",
          tasks: [
            {
              taskId: "T1.1",
              turn: 1,
              title: "Task timing out",
              track: "LIGHT",
              role: "worker",
              category: "general",
              difficulty: "medium",
              targetFiles: ["timeout.ts"],
            },
          ],
        });

        const timeoutResp = (await timeoutServer.handleDispatch({
          sessionId: "dispatch-timeout-f01",
          turn: 1,
          mode: "parallel_spawn",
        })) as AsdDispatchOutput;

        assert.equal(timeoutResp.results[0]?.status, "failed");
        assert.ok(timeoutResp.results[0]?.error?.includes("timed out"));
        const db2 = openProjectDb(projectRoot);
        assert.equal(db2.getTask("dispatch-timeout-f01", "T1.1")?.status, "failed");
        assert.notEqual(db2.getSession("dispatch-timeout-f01")?.phase, "done");
        db2.close();
      } finally {
        if (prevTimeout === undefined) {
          delete process.env.ASD_SPAWN_TIMEOUT_MS;
        } else {
          process.env.ASD_SPAWN_TIMEOUT_MS = prevTimeout;
        }
      }
    });
  });

  describe("5. asd_verify Tool", () => {
    test("verifies LIGHT task, commits changes, resets no_progress_count", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      // Create session & task
      await server.handlePlan({
        action: "create",
        sessionId: "verify-light-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Light Feature", track: "LIGHT", targetFiles: ["feature.ts"] },
          { taskId: "T1.2", turn: 1, title: "Second Task", track: "LIGHT", targetFiles: ["other.ts"] },
        ],
      });

      // Bump no_progress_count
      const db = openProjectDb(projectRoot);
      db.incrementNoProgress("verify-light-1");
      db.incrementNoProgress("verify-light-1");
      assert.equal(db.getSession("verify-light-1")?.no_progress_count, 2);
      db.close();

      // Make edit in allowed file
      fs.writeFileSync(path.join(projectRoot, "feature.ts"), "export const x = 1;\n", "utf8");

      const claim: DoneClaim = {
        summary: "Implemented feature.ts",
        changed_files: ["feature.ts"],
        key_decisions: ["Use TS export"],
        risks: [],
      };

      const verifyResp = (await server.handleVerify({
        sessionId: "verify-light-1",
        taskId: "T1.1",
        doneClaim: claim,
      })) as AsdVerifyOutput;

      assert.equal(verifyResp.verified, true);
      assert.equal(verifyResp.taskId, "T1.1");
      assert.equal(verifyResp.status, "done");
      assert.ok(verifyResp.commitSha);
      assert.ok(verifyResp.progressBoard.includes("### 📊 ASD TODO Progress"));

      // no_progress_count must be reset to 0
      const dbAfter = openProjectDb(projectRoot);
      assert.equal(dbAfter.getSession("verify-light-1")?.no_progress_count, 0);
      dbAfter.close();
    });

    test("verifies HEAVY task worktree, merges into main, cleans up worktree", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      // Create session & task
      await server.handlePlan({
        action: "create",
        sessionId: "verify-heavy-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Heavy Work", track: "HEAVY", targetFiles: ["heavy_worker.ts"] },
        ],
      });

      // Claim task to create worktree
      await server.handleDispatch({
        sessionId: "verify-heavy-1",
        turn: 1,
        mode: "claim_only",
      });

      const wtPath = path.join(projectRoot, ".asd", "wt", "1-T1.1");
      assert.ok(fs.existsSync(wtPath), "Worktree must exist before verify");

      // Edit file inside worktree
      fs.writeFileSync(path.join(wtPath, "heavy_worker.ts"), "export const worker = true;\n", "utf8");

      const claim: DoneClaim = {
        summary: "Completed heavy task",
        changed_files: ["heavy_worker.ts"],
        key_decisions: ["Worktree isolation merged"],
        risks: [],
      };

      const verifyResp = (await server.handleVerify({
        sessionId: "verify-heavy-1",
        taskId: "T1.1",
        doneClaim: claim,
      })) as AsdVerifyOutput;

      assert.equal(verifyResp.verified, true);
      assert.equal(verifyResp.status, "done");
      assert.ok(verifyResp.commitSha);

      // Worktree must be cleaned up after merge
      assert.equal(fs.existsSync(wtPath), false, "Worktree must be removed after successful merge");

      // File must now exist in main projectRoot
      assert.ok(fs.existsSync(path.join(projectRoot, "heavy_worker.ts")));
    });

    test("when all tasks complete, sets session phase = 'done' and generates summary.md", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "complete-session-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Sole Task", track: "LIGHT", targetFiles: ["sole.ts"] },
        ],
      });

      fs.writeFileSync(path.join(projectRoot, "sole.ts"), "export const sole = 42;\n", "utf8");

      const verifyResp = (await server.handleVerify({
        sessionId: "complete-session-1",
        taskId: "T1.1",
        doneClaim: {
          summary: "Sole task done",
          changed_files: ["sole.ts"],
          key_decisions: [],
          risks: [],
        },
      })) as AsdVerifyOutput;

      assert.equal(verifyResp.verified, true);
      assert.equal(verifyResp.status, "done");

      // Session phase must now be 'done'
      const db = openProjectDb(projectRoot);
      const session = db.getSession("complete-session-1");
      assert.equal(session?.phase, "done");
      db.close();

      // Both .asd/summary.md and .asd/sessions/<sessionId>/summary.md must exist
      assert.ok(fs.existsSync(path.join(projectRoot, ".asd", "summary.md")));
      assert.ok(fs.existsSync(path.join(projectRoot, ".asd", "sessions", "complete-session-1", "summary.md")));

      const summaryContent = fs.readFileSync(path.join(projectRoot, ".asd", "summary.md"), "utf8");
      assert.ok(summaryContent.includes("ASD Session Summary"));
      assert.ok(summaryContent.includes("complete-session-1"));
      assert.ok(summaryContent.includes("100%"));
    });
    test("F02: handleVerify respects session.auto_approve = 0 by pausing LIGHT/HEAVY tasks at verifying until approvePendingTask", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "verify-manual-gate-f02",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Light gated task", track: "LIGHT", targetFiles: ["gated-light.ts"] },
          { taskId: "T1.2", turn: 1, title: "Heavy gated task", track: "HEAVY", targetFiles: ["gated-heavy.ts"] },
        ],
      });

      const db = openProjectDb(projectRoot);
      db.updateSessionHarnessInfo("verify-manual-gate-f02", { autoApprove: false });
      assert.equal(db.getSession("verify-manual-gate-f02")?.auto_approve, 0);

      // Claim T1.2 to create worktree
      await server.handleDispatch({
        sessionId: "verify-manual-gate-f02",
        turn: 1,
        mode: "claim_only",
      });

      // 1. LIGHT task edit & verify
      fs.writeFileSync(path.join(projectRoot, "gated-light.ts"), "export const lightGated = 1;\n", "utf8");
      const lightVerify = (await server.handleVerify({
        sessionId: "verify-manual-gate-f02",
        taskId: "T1.1",
        doneClaim: {
          summary: "Light gated summary",
          changed_files: ["gated-light.ts"],
          key_decisions: ["Hold for manual review"],
          risks: [],
        },
      })) as AsdVerifyOutput;

      assert.equal(lightVerify.verified, true);
      assert.equal(lightVerify.status, "verifying");
      assert.equal(lightVerify.commitSha, undefined);
      assert.equal(db.getTask("verify-manual-gate-f02", "T1.1")?.status, "verifying");
      assert.notEqual(db.getSession("verify-manual-gate-f02")?.phase, "done");

      // 2. HEAVY task edit & verify
      const wtPath = path.join(projectRoot, ".asd", "wt", "1-T1.2");
      fs.writeFileSync(path.join(wtPath, "gated-heavy.ts"), "export const heavyGated = 2;\n", "utf8");
      const heavyVerify = (await server.handleVerify({
        sessionId: "verify-manual-gate-f02",
        taskId: "T1.2",
        doneClaim: {
          summary: "Heavy gated summary",
          changed_files: ["gated-heavy.ts"],
          key_decisions: ["Keep worktree for diff"],
          risks: [],
        },
      })) as AsdVerifyOutput;

      assert.equal(heavyVerify.verified, true);
      assert.equal(heavyVerify.status, "verifying");
      assert.equal(heavyVerify.commitSha, undefined);
      assert.equal(db.getTask("verify-manual-gate-f02", "T1.2")?.status, "verifying");
      assert.ok(fs.existsSync(wtPath), "Worktree must stay intact while verifying");
      assert.notEqual(db.getSession("verify-manual-gate-f02")?.phase, "done");

      // Approve both tasks via approvePendingTask
      const { approvePendingTask } = await import("../src/core/workspace.ts");
      const app1 = await approvePendingTask({
        projectRoot,
        sessionId: "verify-manual-gate-f02",
        taskId: "T1.1",
        db,
      });
      assert.equal(app1.ok, true);
      assert.equal(app1.status, "done");
      assert.ok(app1.commitSha);

      const app2 = await approvePendingTask({
        projectRoot,
        sessionId: "verify-manual-gate-f02",
        taskId: "T1.2",
        db,
      });
      assert.equal(app2.ok, true);
      assert.equal(app2.status, "done");
      assert.ok(app2.commitSha);
      assert.equal(fs.existsSync(wtPath), false);

      // Now that all tasks are approved and done, session phase must be 'done' and summary.md written
      assert.equal(db.getSession("verify-manual-gate-f02")?.phase, "done");
      assert.ok(fs.existsSync(path.join(projectRoot, ".asd", "summary.md")));
      const savedClaim = JSON.parse(db.getTask("verify-manual-gate-f02", "T1.2")?.done_claim_json || "{}");
      assert.equal(savedClaim.summary, "Heavy gated summary");

      db.close();
    });
  });

  describe("6. asd_debate Tool", () => {
    test("delegates to debate broker and includes progressBoard in response", async () => {
      const projectRoot = makeProjectRoot();

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(1111);
          const responseJson = JSON.stringify({
            verdict: "APPROVE",
            hard_constraints: ["Constraint 1"],
            decisions: ["Decision 1"],
            risks: ["Risk 1"],
            reasoning: "Proposal is sound",
          });
          opts.onStdout(`\`\`\`json\n${responseJson}\n\`\`\`\n`);
          return { exitCode: 0, pid: 1111 };
        },
      };

      const server = new AsdOrchestrator({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      // Create a session first
      await server.handlePlan({
        action: "create",
        sessionId: "debate-session-1",
        tasks: [{ taskId: "T1.1", turn: 1, title: "Debate Target", targetFiles: ["a.ts"] }],
      });

      const debateResp = (await server.handleDebate({
        sessionId: "debate-session-1",
        taskId: "T1.1",
        topic: "Architecture strategy",
        proposal: "Use erasable typescript syntax only",
      })) as AsdDebateOutput;

      assert.ok(debateResp.debateId);
      assert.equal(debateResp.status, "done");
      assert.equal(debateResp.verdict, "APPROVE");
      assert.deepEqual(debateResp.hardConstraints, ["Constraint 1"]);
      assert.deepEqual(debateResp.decisions, ["Decision 1"]);
      assert.deepEqual(debateResp.risks, ["Risk 1"]);
      assert.equal(typeof debateResp.diversityDegraded, "boolean");

      // Progress board must be present and contain header
      assert.ok(debateResp.progressBoard.includes("### 📊 ASD TODO Progress"));
    });

    test("cross-scope requests bundle caller A files with target B file, link dependsOn [A, B], cap at 2 per subagent, and forward excess to Main Agent", async () => {
      const projectRoot = makeProjectRoot();

      const mockRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(7777);
          const testCwd = opts.cwd ?? projectRoot;
          const loginPath = path.join(testCwd, "src", "ui", "LoginForm.tsx");
          const authPath = path.join(testCwd, "src", "api", "auth.ts");

          if ((opts.cwd ?? "").includes("T1.1")) {
            fs.mkdirSync(path.dirname(loginPath), { recursive: true });
            fs.writeFileSync(loginPath, "export const LoginForm = () => 'login';\n", "utf8");
            const reportBlock = [
              "Implemented LoginForm, but backend API files need additional fields.",
              "```asd-report",
              JSON.stringify(
                {
                  summary: "LoginForm UI implemented",
                  key_decisions: ["Added refreshToken hook call in LoginForm"],
                  risks: ["Requires backend AuthResponse update"],
                  cross_scope_requests: [
                    {
                      target_file: "src/api/auth.ts",
                      caller_files: ["src/ui/LoginForm.tsx"],
                      reason: "LoginForm requires refreshToken field on AuthResponse",
                      suggested_change: "Add refreshToken?: string to AuthResponse interface",
                    },
                    {
                      target_file: "src/api/session.ts",
                      reason: "Session expiry helper needed by UI",
                      suggested_change: "Export isSessionExpired(token: string): boolean",
                    },
                    {
                      target_file: "src/api/audit.ts",
                      reason: "Optional audit log hook for login attempts",
                      suggested_change: "Add recordLoginAttempt()",
                    },
                  ],
                },
                null,
                2
              ),
              "```",
            ].join("\n");
            opts.onStdout(reportBlock + "\n");
          } else if ((opts.cwd ?? "").includes("T1.2")) {
            fs.mkdirSync(path.dirname(authPath), { recursive: true });
            fs.writeFileSync(authPath, "export interface AuthResponse { token: string; }\n", "utf8");
            opts.onStdout("Completed T1.2 backend auth.ts\n");
          }
          return { exitCode: 0, pid: 7777 };
        },
      };

      const server = new AsdOrchestrator({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "cross-scope-session",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Frontend LoginForm",
            track: "HEAVY",
            role: "worker",
            category: "visual-ui",
            difficulty: "medium",
            targetFiles: ["src/ui/LoginForm.tsx", "src/ui/useAuth.ts"],
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "Backend Auth API",
            track: "HEAVY",
            role: "architect",
            category: "general",
            difficulty: "high",
            targetFiles: ["src/api/auth.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleDispatch({
        sessionId: "cross-scope-session",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput;

      assert.equal(dispatchResp.results.length, 2);
      assert.ok(dispatchResp.results.every((r) => r.status === "done"));

      assert.ok(Array.isArray(dispatchResp.autoCreatedTasks));
      assert.equal(dispatchResp.autoCreatedTasks!.length, 2);

      const t21 = dispatchResp.autoCreatedTasks![0]!;
      assert.equal(t21.taskId, "T2.1");
      assert.equal(t21.turn, 2);
      assert.deepEqual(t21.targetFiles, ["src/api/auth.ts", "src/ui/LoginForm.tsx"]);
      assert.deepEqual(t21.dependsOn, ["T1.1", "T1.2"]);

      const t22 = dispatchResp.autoCreatedTasks![1]!;
      assert.equal(t22.taskId, "T2.2");
      assert.equal(t22.turn, 2);
      assert.deepEqual(t22.targetFiles, ["src/api/session.ts", "src/ui/LoginForm.tsx"]);
      assert.deepEqual(t22.dependsOn, ["T1.1"]);

      assert.ok(Array.isArray(dispatchResp.deferredCrossScopeRequests));
      assert.equal(dispatchResp.deferredCrossScopeRequests!.length, 1);
      assert.equal(dispatchResp.deferredCrossScopeRequests![0]!.requestedByTaskId, "T1.1");
      assert.equal(dispatchResp.deferredCrossScopeRequests![0]!.target_file, "src/api/audit.ts");

      assert.ok(dispatchResp.progressBoard.includes("Auto-Created Cross-Scope Follow-up Tasks"));
      assert.ok(dispatchResp.progressBoard.includes("Main Agent Review Required"));
      const db = openProjectDb(projectRoot);
      const session = db.getSession("cross-scope-session");
      assert.notEqual(session?.phase, "done");
      db.close();
    });

    test("T2.3: handleVerify rejects tests/** modifications on docs-only and scout/critic tasks", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      const sid = "asd-20261111-180000-notests";
      await server.handlePlan({
        action: "create",
        sessionId: sid,
        mainHarness: "codex",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Docs-only update",
            track: "LIGHT",
            role: "worker",
            category: "writing",
            targetFiles: ["README.md"],
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "Read-only scout audit",
            track: "LIGHT",
            role: "scout",
            category: "research",
            targetFiles: ["src/app.ts"],
          },
        ],
      });

      await server.handleDispatch({
        sessionId: sid,
        turn: 1,
        mode: "claim_only",
      });

      // Attempt to sneak a test file modification during docs-only T1.1
      fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "tests/sneaky.test.ts"), "// unauthorized\n", "utf8");

      const vDocs = await server.handleVerify({
        sessionId: sid,
        taskId: "T1.1",
        doneClaim: {
          summary: "Tried modifying tests in docs-only task",
          changed_files: ["tests/sneaky.test.ts"],
          key_decisions: [],
          risks: [],
        },
      });
      assert.equal(vDocs.verified, false, "Docs-only task must NOT be allowed to modify tests/**");
      assert.ok(
        vDocs.error?.includes("outside allowedFiles") ||
          vDocs.violations?.some((v) => v.includes("sneaky.test.ts")),
        `Expected boundary violation for sneaky.test.ts, got: ${JSON.stringify(vDocs)}`
      );
      fs.rmSync(path.join(projectRoot, "tests/sneaky.test.ts"), { force: true });

      // Attempt to sneak a test file modification during scout T1.2
      fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "tests/scout.test.ts"), "// unauthorized\n", "utf8");

      const vScout = await server.handleVerify({
        sessionId: sid,
        taskId: "T1.2",
        doneClaim: {
          summary: "Tried modifying tests in scout task",
          changed_files: ["tests/scout.test.ts"],
          key_decisions: [],
          risks: [],
        },
      });
      assert.equal(vScout.verified, false, "Scout task must NOT be allowed to modify tests/**");
      assert.ok(
        vScout.error?.includes("outside allowedFiles") ||
          vScout.violations?.some((v) => v.includes("scout.test.ts")),
        `Expected boundary violation for scout.test.ts, got: ${JSON.stringify(vScout)}`
      );
    });
  });
});


describe("T2.1: ACP Hybrid Dispatch, In-Place Idle Resume & Async Dispatch", () => {
  test("parseSubagentReport unwraps Antigravity stream-json NDJSON envelopes", () => {
    const ndjson = [
      JSON.stringify({ event: "init", conversation_id: "agy-1" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: '```asd-report\n{"summary":"Streamed report","key_decisions":["Used ACP"],"risks":[]}\n```',
        },
      }),
    ].join("\n");
    const parsed = parseSubagentReport(ndjson);
    assert.ok(parsed);
    assert.equal(parsed?.summary, "Streamed report");
    assert.deepEqual(parsed?.key_decisions, ["Used ACP"]);
  });

  test("executes HEAVY parallel_spawn via ACP (with in-place idle stall session/load resume) and supports async: true", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asd-mcp-acp-proj-"));
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-mcp-acp-mock-"));
    runGit(["init"], { cwd: projectRoot });
    ensureGitUserIdentity(projectRoot);
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src/acp-target.ts"), "export const x = 1;\n", "utf8");
    runGit(["add", "."], { cwd: projectRoot });
    runGit(["commit", "-m", "init"], { cwd: projectRoot });

    const mockAcpServer = path.join(mockDir, "mock-acp-worker.mjs");
    fs.writeFileSync(
      mockAcpServer,
      `
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let cwd = process.cwd();
let loaded = false;

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    cwd = msg.params.cwd || cwd;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-worker-ses-1" } });
  } else if (msg.method === "session/load") {
    loaded = true;
    cwd = msg.params.cwd || cwd;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
  } else if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    if (!loaded) {
      fs.writeFileSync(path.join(cwd, "src/acp-target.ts"), "export const x = 2; // partial\\n", "utf8");
      return;
    }
    const prev = fs.readFileSync(path.join(cwd, "src/acp-target.ts"), "utf8");
    const finalVal = prev.includes("partial") ? 42 : 0;
    fs.writeFileSync(path.join(cwd, "src/acp-target.ts"), \`export const x = \${finalVal};\\n\`, "utf8");
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: '\`\`\`asd-report\\n{"summary":"Completed via ACP resume","key_decisions":["Resumed same worktree"],"risks":[]}\\n\`\`\`'
          }
        }
      }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
      `.trim()
    );

    const prevIdle = process.env.ASD_SPAWN_IDLE_TIMEOUT_MS;
    process.env.ASD_SPAWN_IDLE_TIMEOUT_MS = "250";
    const server = new AsdOrchestrator({
      projectRoot,
      autoSync: false,
      acpCommandOverride: { command: process.execPath, args: [mockAcpServer] },
    });
    try {
      const plan = await server.handlePlan({
        action: "create",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "ACP worker task with idle recovery",
            track: "HEAVY",
            role: "worker",
            targetFiles: ["src/acp-target.ts"],
            verifyCmd: "node -e \"process.exit(0)\"",
          },
        ],
      });

      const asyncStart = await server.handleDispatch({
        sessionId: plan.sessionId,
        turn: 1,
        mode: "parallel_spawn",
        harness: "opencode",
        async: true,
        openCodeSessionId: "ses_oc_main_1",
      });

      assert.equal(asyncStart.async, true);
      assert.equal(asyncStart.asyncJob?.status, "running");
      assert.equal(asyncStart.asyncJob?.openCodeSessionId, "ses_oc_main_1");

      const finishedJob = await waitForAsyncDispatch(projectRoot, plan.sessionId, {
        timeoutMs: 15000,
        pollIntervalMs: 100,
      });
      assert.equal(finishedJob.status, "done");
      assert.equal(finishedJob.results?.[0]?.status, "done");

      const mergedContent = fs.readFileSync(path.join(projectRoot, "src/acp-target.ts"), "utf8");
      assert.ok(
        mergedContent.includes("export const x = 42;"),
        `Expected merged worktree content from resumed ACP session, got: ${mergedContent}`
      );
    } finally {
      server.close();
      if (prevIdle === undefined) delete process.env.ASD_SPAWN_IDLE_TIMEOUT_MS;
      else process.env.ASD_SPAWN_IDLE_TIMEOUT_MS = prevIdle;
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });

  describe("9. v2.8 DIRECT Track, Guardrails, 3-Strike Escalation & Telemetry", () => {
    test("supports DIRECT track end-to-end (plan -> claim_only -> in-place verify)", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      const planRes = await server.handlePlan({
        action: "create",
        sessionId: "asd-20261120-080001-dir1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Direct single-file edit",
            track: "DIRECT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["hello.txt"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      });
      assert.equal(planRes.tasks[0]?.track, "DIRECT");

      // Default mode omitted -> DIRECT defaults to claim_only (no external CLI spawn)
      const dispRes = await server.handleDispatch({
        sessionId: "asd-20261120-080001-dir1",
        turn: 1,
      });
      assert.equal(dispRes.results[0]?.status, "running");

      fs.writeFileSync(path.join(projectRoot, "hello.txt"), "direct edit\n", "utf8");
      const verRes = await server.handleVerify({
        sessionId: "asd-20261120-080001-dir1",
        taskId: "T1.1",
        doneClaim: {
          summary: "Applied direct edit",
          changed_files: ["hello.txt"],
          key_decisions: [],
          risks: [],
        },
      });
      assert.equal(verRes.verified, true);
      assert.equal(verRes.status, "done");
      assert.ok(verRes.commitSha);
    });

    test("emits warnings for specialist role + domain category mismatch and overlapping same-turn LIGHT targetFiles", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      const planRes = await server.handlePlan({
        action: "create",
        sessionId: "asd-20261120-080002-wrn1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Specialist with category",
            track: "LIGHT",
            role: "architect",
            category: "visual-ui",
            difficulty: "medium",
            targetFiles: ["src/shared.ts"],
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "Overlapping LIGHT worker",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["src/shared.ts"],
          },
        ],
      });

      assert.ok(Array.isArray(planRes.warnings) && planRes.warnings.length >= 2);
      assert.ok(planRes.warnings!.some((w) => w.includes("Tier 2 precedence") && w.includes("architect")));
      assert.ok(planRes.warnings!.some((w) => w.includes("overlapping targetFiles") && w.includes("src/shared.ts")));

      const dispRes = await server.handleDispatch({
        sessionId: "asd-20261120-080002-wrn1",
        turn: 1,
        mode: "claim_only",
      });
      assert.ok(Array.isArray(dispRes.concurrencyWarnings) && dispRes.concurrencyWarnings.length >= 1);
      assert.ok(dispRes.concurrencyWarnings![0]!.includes("overlapping targetFiles"));
    });

    test("returns progressive 3-Strike escalationHint and logPath on verification failure", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdOrchestrator({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handlePlan({
        action: "create",
        sessionId: "asd-20261120-080003-strk",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Failing verification task",
            track: "LIGHT",
            targetFiles: ["a.txt"],
            verifyCmd: 'node -e "console.error(\'boom\'); process.exit(1)"',
          },
        ],
      });
      fs.writeFileSync(path.join(projectRoot, "a.txt"), "x\n", "utf8");

      const claim = { summary: "try", changed_files: ["a.txt"], key_decisions: [], risks: [] };
      const r1 = await server.handleVerify({ sessionId: "asd-20261120-080003-strk", taskId: "T1.1", doneClaim: claim });
      assert.equal(r1.verified, false);
      assert.equal(r1.attempts, 1);
      assert.ok(r1.escalationHint?.includes("Strike 1/3"));
      assert.ok(r1.logPath);

      const r2 = await server.handleVerify({ sessionId: "asd-20261120-080003-strk", taskId: "T1.1", doneClaim: claim });
      assert.equal(r2.attempts, 2);
      assert.ok(r2.escalationHint?.includes("Strike 2/3"));
      assert.ok(r2.escalationHint?.includes("asd-critic"));

      const r3 = await server.handleVerify({ sessionId: "asd-20261120-080003-strk", taskId: "T1.1", doneClaim: claim });
      assert.equal(r3.attempts, 3);
      assert.ok(r3.escalationHint?.includes("Strike 3/3"));
      assert.ok(r3.escalationHint?.includes("asd debate"));
    });

    test("PLAN_SCHEMA_DEFINITION documents DIRECT/LIGHT/HEAVY tracks", () => {
      assert.deepEqual(
        PLAN_SCHEMA_DEFINITION.properties.tasks.items.properties.track.enum,
        ["DIRECT", "LIGHT", "HEAVY"]
      );
    });
  });
});
