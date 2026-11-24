/**
 * ASD v2.2 Debate Broker Unit & Integration Tests (tests/debate-broker.test.ts).
 *
 * Verifies:
 * 1. Structured verdict parser (parseReviewerOpening) with code blocks, direct JSON, embedded JSON.
 * 2. Unanimous APPROVE/MINOR_AMEND early exit after Round 1 (no Round 2 spawn).
 * 3. REJECT triggering Round 2 arbiter synthesis and automatic injection into tasks.acceptance and PLAN.md.
 * 4. Graceful recovery when one parallel reviewer crashes/times out as long as at least 1 survives.
 * 5. Failure when all reviewers crash/fail in Round 1.
 * 6. Cross-model diverse reviewer selection and diversity degradation tag handling.
 * 7. Debate execution without taskId.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDebateBroker,
  parseReviewerOpening,
  formatDebateAcceptance,
  deduplicateStrings,
  buildDefaultHarnessCommand,
  buildDebateCodeContext,
  buildRound2CitedCodeContext,
} from "../src/core/debate.ts";
import { openProjectDb, SqliteDriver } from "../src/core/db.ts";
import type { CommandRunner, CommandRunnerRunOptions } from "../src/core/spawner.ts";
import type { RoutingConfig, SubagentSessionMeta } from "../src/core/types.ts";

const tmpDirs: string[] = [];
const openDrivers: SqliteDriver[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-debate-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const drv of openDrivers) {
    try {
      drv.close();
    } catch {
      // Ignore already-closed
    }
  }
  openDrivers.length = 0;

  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  tmpDirs.length = 0;
});

describe("debate-broker.ts", () => {
  describe("1. Structured Verdict JSON Parser", () => {
    test("parses pure JSON with snake_case and camelCase", () => {
      const json1 = JSON.stringify({
        verdict: "APPROVE",
        hard_constraints: ["Constraint 1", "Constraint 2"],
        decisions: ["Decision 1"],
        risks: ["Risk 1"],
        reasoning: "Looks solid",
      });
      const parsed1 = parseReviewerOpening(json1);
      assert.ok(parsed1);
      assert.equal(parsed1.verdict, "APPROVE");
      assert.deepEqual(parsed1.hard_constraints, ["Constraint 1", "Constraint 2"]);
      assert.deepEqual(parsed1.decisions, ["Decision 1"]);
      assert.deepEqual(parsed1.risks, ["Risk 1"]);
      assert.equal(parsed1.reasoning, "Looks solid");

      // camelCase keys
      const json2 = JSON.stringify({
        verdict: "MINOR_AMEND",
        hardConstraints: ["Constraint A"],
        decisions: ["Decision A"],
        risks: ["Risk A"],
        reason: "Needs small fix",
      });
      const parsed2 = parseReviewerOpening(json2);
      assert.ok(parsed2);
      assert.equal(parsed2.verdict, "MINOR_AMEND");
      assert.deepEqual(parsed2.hard_constraints, ["Constraint A"]);
      assert.equal(parsed2.reasoning, "Needs small fix");
    });

    test("extracts JSON enclosed within markdown ```json code blocks", () => {
      const text = `
Here is my review:
\`\`\`json
{
  "verdict": "REJECT",
  "hard_constraints": ["Must not alter global state"],
  "decisions": ["Rollback proposed architecture"],
  "risks": ["Race conditions in concurrent requests"],
  "reasoning": "Global mutable state causes unpredictable failures"
}
\`\`\`
Hope this helps!
`;
      const parsed = parseReviewerOpening(text);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "REJECT");
      assert.deepEqual(parsed.hard_constraints, ["Must not alter global state"]);
      assert.deepEqual(parsed.decisions, ["Rollback proposed architecture"]);
      assert.deepEqual(parsed.risks, ["Race conditions in concurrent requests"]);
    });

    test("extracts JSON embedded in raw stdout surrounded by log noise", () => {
      const text = `
[INFO] Initializing subagent CLI...
[DEBUG] Model loaded: gpt-5-codex
{"verdict":"APPROVE","hard_constraints":[],"decisions":["Use Node 22 native TS"],"risks":[]}
[INFO] Finished execution with exit code 0
`;
      const parsed = parseReviewerOpening(text);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "APPROVE");
      assert.deepEqual(parsed.decisions, ["Use Node 22 native TS"]);
    });

    test("returns null for invalid verdict or unparseable text", () => {
      assert.equal(parseReviewerOpening(""), null);
      assert.equal(parseReviewerOpening("Random non-json text without verdict"), null);
      assert.equal(parseReviewerOpening('{"verdict": "MAYBE"}'), null);
      assert.equal(parseReviewerOpening('{"some_key": 123}'), null);
    });
  });

  describe("2. Helper Utilities", () => {
    test("deduplicateStrings removes duplicates and trims whitespace", () => {
      const res = deduplicateStrings(["  a ", "b", "a", "c", "", "  b  "]);
      assert.deepEqual(res, ["a", "b", "c"]);
    });

    test("formatDebateAcceptance formats decisions and hard constraints cleanly", () => {
      const text = formatDebateAcceptance(
        "D1",
        ["Must use WAL mode", "Zero external deps"],
        ["Adopt SQLite SSOT"]
      );
      assert.ok(text.includes("[Debate D1] Decisions: Adopt SQLite SSOT"));
      assert.ok(text.includes("[Debate D1] Hard Constraints: Must use WAL mode; Zero external deps"));
    });

    test("buildDefaultHarnessCommand builds correct command and args per harness", () => {
      const cc = buildDefaultHarnessCommand("claude-code", "Review this", "claude-sonnet-4-6");
      assert.equal(cc.command, "claude");
      assert.deepEqual(cc.args, ["-p", "Review this", "--output-format", "json", "--model", "claude-sonnet-4-6"]);

      const oc = buildDefaultHarnessCommand("opencode", "Review this", "glm-5");
      assert.equal(oc.command, "opencode");
      assert.deepEqual(oc.args, ["run", "Review this", "--format", "json", "--model", "glm-5"]);

      const cx = buildDefaultHarnessCommand("codex", "Review this", "gpt-5-codex");
      assert.equal(cx.command, "codex");
      assert.deepEqual(cx.args, ["exec", "Review this", "--json", "-m", "gpt-5-codex"]);

      const ag = buildDefaultHarnessCommand("antigravity", "Review this", "gemini-3-pro");
      assert.equal(ag.command, "agy");
      assert.deepEqual(ag.args, ["-p", "Review this", "--output-format", "json", "--model", "gemini-3-pro"]);
    });
  });

  describe("3. Round 1 Early Exit (Unanimous APPROVE / MINOR_AMEND)", () => {
    test("unanimous APPROVE/MINOR_AMEND synthesizes InsightVerdict immediately without Round 2", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-early-exit";
      const taskId = "T1.1";

      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sessionId, [
        {
          taskId,
          turn: 1,
          title: "Implement Core Database",
          acceptance: "Base test suite must pass",
        },
      ]);

      const round1Calls: string[] = [];

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          round1Calls.push(meta.subSessionId);

          opts.onSpawn?.(1001);

          if (meta.subSessionId.includes("r1-1")) {
            // Reviewer 1: APPROVE
            opts.onStdout(
              JSON.stringify({
                verdict: "APPROVE",
                hard_constraints: ["Keep zero external dependencies"],
                decisions: ["Use standard library fs and sqlite"],
                risks: ["Windows path separators"],
                reasoning: "Architecturally clean and minimal",
              })
            );
          } else {
            // Reviewer 2: MINOR_AMEND
            opts.onStdout(
              JSON.stringify({
                verdict: "MINOR_AMEND",
                hard_constraints: ["Enable WAL mode explicitly"],
                decisions: ["Set busy_timeout to 5000ms"],
                risks: ["Lock timeout on high concurrency"],
                reasoning: "Need WAL mode for safe multi-process reads",
              })
            );
          }
          return { exitCode: 0, pid: 1001 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-EARLY",
        topic: "Use SQLite SSOT for session management",
        proposal: "Store sessions and tasks in local SQLite database with WAL mode.",
        commandRunner: mockRunner,
        db,
      });

      // 1. Assert early exit verdict is MINOR_AMEND (due to Reviewer 2)
      assert.equal(result.status, "done");
      assert.equal(result.verdict, "MINOR_AMEND");
      assert.equal(result.round2Bundle, null);
      assert.equal(round1Calls.length, 2);
      assert.ok(round1Calls.every((c) => !c.includes("r2")));

      // 2. Assert union of constraints and decisions
      assert.ok(result.hardConstraints.includes("Keep zero external dependencies"));
      assert.ok(result.hardConstraints.includes("Enable WAL mode explicitly"));
      assert.ok(result.decisions.includes("Use standard library fs and sqlite"));
      assert.ok(result.decisions.includes("Set busy_timeout to 5000ms"));

      // 3. Assert DB record
      const debateRow = db.getDebate("D-EARLY")!;
      assert.ok(debateRow);
      assert.equal(debateRow.status, "done");
      assert.ok(debateRow.round1_bundle_json);
      assert.equal(debateRow.round2_bundle_json, null);
      const parsedInsight = JSON.parse(debateRow.insight_verdict_json!);
      assert.equal(parsedInsight.verdict, "MINOR_AMEND");

      // 4. Assert automatic acceptance injection into tasks table
      const taskRow = db.getTask(sessionId, taskId)!;
      assert.ok(taskRow.acceptance);
      assert.ok(taskRow.acceptance.includes("Base test suite must pass"));
      assert.ok(taskRow.acceptance.includes("[Debate D-EARLY]"));
      assert.ok(taskRow.acceptance.includes("Enable WAL mode explicitly"));
      assert.ok(taskRow.acceptance.includes("Set busy_timeout to 5000ms"));

      // 5. Assert .asd/PLAN.md was created/updated
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      assert.ok(fs.existsSync(planMdPath));
      const planContent = fs.readFileSync(planMdPath, "utf8");
      assert.ok(planContent.includes("T1.1"));
      assert.ok(planContent.includes("Enable WAL mode explicitly"));
    });
  });

  describe("4. Round 2 Conflict Resolution (REJECT -> Arbiter Pass)", () => {
    test("REJECT triggers Round 2 arbiter synthesis and automatic injection into tasks.acceptance", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-round2-test";
      const taskId = "T2.1";

      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sessionId, [
        {
          taskId,
          turn: 1,
          title: "Multi-Harness Dispatcher",
          acceptance: "Original acceptance criteria",
        },
      ]);

      const subSessionCalls: string[] = [];

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          subSessionCalls.push(meta.subSessionId);

          opts.onSpawn?.(2002);

          if (meta.subSessionId.includes("r1-1")) {
            // Reviewer 1: REJECT
            opts.onStdout(
              JSON.stringify({
                verdict: "REJECT",
                hard_constraints: ["Must not spawn subagents without worktree isolation"],
                decisions: ["Reject in-place modifications for HEAVY tasks"],
                risks: ["Git index corruption during concurrent writes"],
                reasoning: "Concurrent writes on dirty working tree will cause severe merge conflicts",
              })
            );
          } else if (meta.subSessionId.includes("r1-2")) {
            // Reviewer 2: APPROVE
            opts.onStdout(
              JSON.stringify({
                verdict: "APPROVE",
                hard_constraints: [],
                decisions: ["Fast parallel execution is primary"],
                risks: [],
                reasoning: "In-place modifications are fastest",
              })
            );
          } else if (meta.subSessionId.includes("r2-arbiter")) {
            // Round 2 Arbiter: Resolves conflict -> MINOR_AMEND with Worktrees
            opts.onStdout(
              JSON.stringify({
                verdict: "MINOR_AMEND",
                hard_constraints: [
                  "HEAVY tasks must use isolated git worktrees",
                  "LIGHT tasks can use in-place commits",
                ],
                decisions: [
                  "Adopt dual-track execution (LIGHT vs HEAVY)",
                  "HEAVY tasks write to .asd/wt/<turn>-<taskId>/",
                ],
                risks: ["Worktree creation latency"],
                reasoning:
                  "Dual track balances speed for light changes with absolute isolation for heavy changes.",
              })
            );
          }
          return { exitCode: 0, pid: 2002 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-CONFLICT",
        topic: "Concurrent execution safety mechanism",
        proposal: "Run subagents concurrently directly in the workspace directory without worktrees.",
        commandRunner: mockRunner,
        db,
      });

      // 1. Assert Round 2 was triggered and Arbiter verdict synthesized
      assert.equal(result.status, "done");
      assert.equal(result.verdict, "MINOR_AMEND");
      assert.ok(result.round2Bundle);
      assert.equal(result.round2Bundle.arbiterVerdict.verdict, "MINOR_AMEND");

      // Verify execution sequence: 2 Round 1 subagents + 1 Round 2 arbiter subagent
      assert.equal(subSessionCalls.length, 3);
      assert.ok(subSessionCalls.some((c) => c.includes("r1-1")));
      assert.ok(subSessionCalls.some((c) => c.includes("r1-2")));
      assert.ok(subSessionCalls.some((c) => c.includes("r2-arbiter")));

      // 2. Assert hard constraints and decisions contain Arbiter resolution
      assert.ok(result.hardConstraints.includes("HEAVY tasks must use isolated git worktrees"));
      assert.ok(result.decisions.includes("Adopt dual-track execution (LIGHT vs HEAVY)"));

      // 3. Assert DB record has both bundles populated
      const debateRow = db.getDebate("D-CONFLICT")!;
      assert.ok(debateRow);
      assert.equal(debateRow.status, "done");
      assert.ok(debateRow.round1_bundle_json);
      assert.ok(debateRow.round2_bundle_json);
      const parsedR2 = JSON.parse(debateRow.round2_bundle_json);
      assert.equal(parsedR2.arbiterVerdict.role, "arbiter");

      // 4. Assert automatic acceptance injection into tasks.acceptance
      const taskRow = db.getTask(sessionId, taskId)!;
      assert.ok(taskRow.acceptance);
      assert.ok(taskRow.acceptance.includes("Original acceptance criteria"));
      assert.ok(taskRow.acceptance.includes("[Debate D-CONFLICT]"));
      assert.ok(taskRow.acceptance.includes("HEAVY tasks must use isolated git worktrees"));
      assert.ok(taskRow.acceptance.includes("Adopt dual-track execution (LIGHT vs HEAVY)"));

      // 5. Assert .asd/PLAN.md contains the updated acceptance
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      assert.ok(fs.existsSync(planMdPath));
      const planContent = fs.readFileSync(planMdPath, "utf8");
      assert.ok(planContent.includes("dual-track execution"));
    });
  });

  describe("5. Fault Tolerance & Graceful Recovery", () => {
    test("recovers gracefully when 1 reviewer crashes with exit code 1", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-crash-recovery";
      const taskId = "T3.1";

      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sessionId, [
        {
          taskId,
          turn: 1,
          title: "Fault Tolerant Task",
          acceptance: "Original",
        },
      ]);

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

          opts.onSpawn?.(3003);

          if (meta.subSessionId.includes("r1-1")) {
            // Reviewer 1 crashes
            opts.onStderr("Fatal error: connection reset by peer");
            return { exitCode: 1, pid: 3003 };
          } else {
            // Reviewer 2 succeeds: APPROVE
            opts.onStdout(
              JSON.stringify({
                verdict: "APPROVE",
                hard_constraints: ["Graceful fallback mandatory"],
                decisions: ["Use surviving opening"],
                risks: [],
                reasoning: "One reviewer crashed, but surviving opening is sound",
              })
            );
            return { exitCode: 0, pid: 3003 };
          }
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-CRASH",
        topic: "Graceful recovery test",
        proposal: "Survive single reviewer crash.",
        commandRunner: mockRunner,
        db,
      });

      // 1. Should complete without throwing
      assert.equal(result.status, "done");
      assert.equal(result.verdict, "APPROVE");

      // 2. Assert bundles record surviving opening and failure
      assert.equal(result.round1Bundle.openings.length, 1);
      assert.equal(result.round1Bundle.failedReviewers.length, 1);
      assert.ok(result.round1Bundle.failedReviewers[0]!.error.includes("code 1"));

      // 3. Assert surviving opening decisions and constraints were injected
      assert.ok(result.hardConstraints.includes("Graceful fallback mandatory"));
      assert.ok(result.decisions.includes("Use surviving opening"));

      const taskRow = db.getTask(sessionId, taskId)!;
      assert.ok(taskRow.acceptance!.includes("Graceful fallback mandatory"));
    });

    test("throws Error when ALL reviewers in Round 1 fail or crash", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-all-fail";

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(4004);
          opts.onStderr("Fatal process crash");
          return { exitCode: 1, pid: 4004 };
        },
      };

      await assert.rejects(
        async () => {
          await runDebateBroker({
            projectRoot,
            sessionId,
            debateId: "D-ALL-FAIL",
            topic: "All fail topic",
            proposal: "This should fail because no reviewers survive",
            commandRunner: mockRunner,
            db,
          });
        },
        /All debate reviewers failed or timed out in Round 1/
      );

      // F14: debate row must be transitioned to 'failed' with round1_bundle_json recorded, and prompt.md finalized
      const failedRow = db.getDebate("D-ALL-FAIL");
      assert.ok(failedRow, "Debate row must exist");
      assert.equal(failedRow.status, "failed");
      assert.ok(failedRow.round1_bundle_json, "round1_bundle_json must record failedReviewers");
      const r1Bundle = JSON.parse(failedRow.round1_bundle_json);
      assert.equal(r1Bundle.openings.length, 0);
      assert.ok(r1Bundle.failedReviewers.length >= 1);

      const subagentsDir = path.join(projectRoot, ".asd", "sessions", sessionId, "subagents");
      if (fs.existsSync(subagentsDir)) {
        for (const entry of fs.readdirSync(subagentsDir)) {
          assert.equal(
            fs.existsSync(path.join(subagentsDir, entry, "prompt.md")),
            false,
            "prompt.md must be purged by finalizeSubagentArtifacts on all-fail debate"
          );
        }
      }
    });
  });

  describe("6. Cross-Model Diversity Selection & Fallbacks", () => {
    test("selects diverse reviewers with different model families and harnesses", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const capturedReviewers: Array<{ harness: string; model: string }> = [];

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          capturedReviewers.push({ harness: meta.harness, model: meta.model });

          opts.onSpawn?.(5005);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: [],
              risks: [],
            })
          );
          return { exitCode: 0, pid: 5005 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-diversity",
        topic: "Cross model diversity",
        proposal: "Evaluate reviewer selection",
        proposerRoute: {
          harness: "claude-code",
          model: "claude-opus-4-6",
          modelFamily: "claude",
        },
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(capturedReviewers.length, 2);

      // Proposer was claude-code / claude. Reviewer 1 (critic) should be codex/gpt, Reviewer 2 (analyst) should be opencode/glm
      const harnesses = capturedReviewers.map((r) => r.harness);
      assert.ok(harnesses.includes("codex") || harnesses.includes("opencode"));
      assert.equal(result.diversityDegraded, false);
    });

    test("flags diversityDegraded: true when single model family is available", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(6006);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: [],
              risks: [],
            })
          );
          return { exitCode: 0, pid: 6006 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-single-family",
        topic: "Degraded diversity test",
        proposal: "Single family restricted environment",
        runtimeCapabilities: {
          availableModelFamilies: ["claude"],
        },
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(result.diversityDegraded, true);
    });
  });

  describe("7. Debate without taskId", () => {
    test("completes successfully and persists debate record without modifying tasks table", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(7007);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: ["Constraint X"],
              decisions: ["Decision Y"],
              risks: [],
            })
          );
          return { exitCode: 0, pid: 7007 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-no-task",
        topic: "General architecture question",
        proposal: "Should we use event-driven microservices?",
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(result.verdict, "APPROVE");
      assert.equal(result.taskId, null);
      assert.equal(result.updatedAcceptance, undefined);

      const debateRow = db.getDebate(result.debateId);
      assert.ok(debateRow);
      assert.equal(debateRow.status, "done");
      assert.equal(debateRow.task_id, null);
    });

    test("retries without --model flag when preset model is unconfigured in CLI harness", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const seenArgs: string[][] = [];
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          seenArgs.push(args);
          opts.onSpawn?.(8008);
          if (args.includes("--model") || args.includes("-m")) {
            opts.onStderr("Error: model glm-5 not found in provider config\n");
            return { exitCode: 1, pid: 8008 };
          }
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: ["Fallback to default CLI model succeeded"],
              decisions: ["Use default model when preset model is missing"],
              risks: [],
              reasoning: "Default model worked cleanly",
            })
          );
          return { exitCode: 0, pid: 8008 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-model-fallback",
        topic: "Unconfigured preset model fallback",
        proposal: "Retry without --model if exitCode !== 0",
        reviewerRoutes: [
          { harness: "opencode", model: "glm-5", role: "critic" },
        ],
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(result.verdict, "APPROVE");
      assert.equal(seenArgs.length, 2);
      assert.ok(seenArgs[0]!.includes("--model"));
      assert.ok(!seenArgs[1]!.includes("--model"));
      assert.equal(result.round1Bundle.openings[0]?.model, "default");
      assert.ok(
        result.hardConstraints.includes("Fallback to default CLI model succeeded")
      );
    });

    test("unwraps OpenCode NDJSON event stream containing escaped JSON markdown fence", () => {
      const ndjson = [
        JSON.stringify({ type: "step_start", timestamp: 1000, part: { type: "step-start" } }),
        JSON.stringify({
          type: "text",
          timestamp: 2000,
          part: {
            type: "text",
            text: '```json\n{\n  "verdict": "MINOR_AMEND",\n  "hard_constraints": ["Preserve NDJSON compatibility"],\n  "decisions": ["Unwrap part.text before parsing"],\n  "risks": ["Escaped quotes in outer JSON"],\n  "reasoning": "OpenCode --format json wraps assistant markdown inside NDJSON text events"\n}\n```',
          },
        }),
        JSON.stringify({ type: "step_finish", timestamp: 3000, part: { type: "step-finish" } }),
      ].join("\r\n");

      const parsed = parseReviewerOpening(ndjson);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "MINOR_AMEND");
      assert.deepEqual(parsed.hard_constraints, ["Preserve NDJSON compatibility"]);
      assert.deepEqual(parsed.decisions, ["Unwrap part.text before parsing"]);
    });

    test("embeds ground-truth source slices (--files) and adversarial evidence instructions into Round 1 prompt", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sampleFile = path.join(projectRoot, "src", "sample.ts");
      fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
      fs.writeFileSync(
        sampleFile,
        [
          "export function computeTotal(items: number[]): number {",
          "  let sum = 0;",
          "  for (const x of items) sum += x;",
          "  return sum;",
          "}",
        ].join("\n"),
        "utf8"
      );

      const ctx = buildDebateCodeContext(projectRoot, ["src/sample.ts:1-4"]);
      assert.ok(ctx.includes("### File: src/sample.ts (Lines 1-4 of 5)"));
      assert.ok(ctx.includes("1: export function computeTotal(items: number[]): number {"));
      assert.ok(ctx.includes("4:   return sum;"));
      assert.ok(!ctx.includes("5: }"));

      let capturedPrompt = "";
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          capturedPrompt = args.join(" ");
          opts.onSpawn?.(9009);
          opts.onStdout(
            JSON.stringify({
              verdict: "MINOR_AMEND",
              hard_constraints: ["src/sample.ts:3 must guard against NaN"],
              decisions: ["Add Number.isFinite check at src/sample.ts:3"],
              risks: ["NaN propagation in src/sample.ts:3"],
              reasoning: "Verified against src/sample.ts:1-4",
            })
          );
          return { exitCode: 0, pid: 9009 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-code-context",
        topic: "Audit computeTotal implementation",
        proposal: "computeTotal has an off-by-one bug",
        files: ["src/sample.ts:1-4"],
        reviewerRoutes: [
          { harness: "opencode", model: "glm-5", role: "critic" },
        ],
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.verdict, "MINOR_AMEND");
      assert.ok(capturedPrompt.includes("## Ground-Truth Source Code"));
      assert.ok(capturedPrompt.includes("1: export function computeTotal"));
      assert.ok(capturedPrompt.includes("UNVERIFIED hypothesis"));
      assert.ok(capturedPrompt.includes("file:line"));
    });

    test("supports explicit harnesses (--harnesses), roles (--roles), models (--models), and count (--count) selection", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const routingConfig: RoutingConfig = {
        _asdVersion: "2.5.0",
        agents: {
          critic: {
            harness: "opencode" as const,
            model: "nvidia/z-ai/glm-5.3-flash",
            modelFamily: "glm",
            fallbacks: [{ harness: "codex" as const, model: "gpt-6.1-sol", modelFamily: "gpt" }],
          },
          architect: {
            harness: "codex" as const,
            model: "gpt-6.1-sol",
            modelFamily: "gpt",
            fallbacks: [{ harness: "claude-code" as const, model: "claude-opus-5-5", modelFamily: "claude" }],
          },
          planner: {
            harness: "claude-code" as const,
            model: "claude-sonnet-5-5",
            modelFamily: "claude",
            fallbacks: [],
          },
          worker: {
            harness: "opencode" as const,
            model: "nvidia/z-ai/glm-5.3-flash",
            modelFamily: "glm",
            fallbacks: [],
          },
          scout: {
            harness: "antigravity" as const,
            model: "gemini-3-flash-lite",
            modelFamily: "gemini",
            fallbacks: [],
          },
        },
        categories: {},
      };

      const capturedHarnesses: Array<{ harness: string; model: string; role: string }> = [];
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          capturedHarnesses.push({ harness: meta.harness, model: meta.model, role: meta.role });
          opts.onSpawn?.(9100);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: [`Approved by ${meta.harness}`],
              risks: [],
              reasoning: "LGTM",
            })
          );
          return { exitCode: 0, pid: 9100 };
        },
      };

      // 1. Explicit --harnesses opencode,codex,claude-code (3 harnesses)
      const resHarnesses = await runDebateBroker({
        projectRoot,
        sessionId: "sess-harnesses",
        topic: "Multi-harness explicit selection",
        proposal: "Spawn 3 specific harnesses",
        harnesses: ["opencode", "codex", "claude-code"],
        routingConfig,
        commandRunner: mockRunner,
        db,
      });
      assert.equal(resHarnesses.verdict, "APPROVE");
      assert.equal(capturedHarnesses.length, 3);
      assert.deepEqual(
        capturedHarnesses.map((c) => c.harness),
        ["opencode", "codex", "claude-code"]
      );
      assert.equal(capturedHarnesses[0]!.model, "nvidia/z-ai/glm-5.3-flash");
      assert.equal(capturedHarnesses[1]!.model, "gpt-6.1-sol");
      assert.equal(capturedHarnesses[2]!.model, "claude-sonnet-5-5");

      // 2. Explicit --roles critic,architect,planner from routing.jsonc
      capturedHarnesses.length = 0;
      const resRoles = await runDebateBroker({
        projectRoot,
        sessionId: "sess-roles",
        topic: "Role-based selection from routing.jsonc",
        proposal: "Assign critic, architect, and planner from routing.jsonc",
        roles: ["critic", "architect", "planner"],
        routingConfig,
        commandRunner: mockRunner,
        db,
      });
      assert.equal(resRoles.verdict, "APPROVE");
      assert.equal(capturedHarnesses.length, 3);
      assert.deepEqual(
        capturedHarnesses.map((c) => c.role),
        ["critic", "architect", "planner"]
      );
      assert.deepEqual(
        capturedHarnesses.map((c) => c.harness),
        ["opencode", "codex", "claude-code"]
      );

      // 3. Explicit --count 4
      capturedHarnesses.length = 0;
      const resCount = await runDebateBroker({
        projectRoot,
        sessionId: "sess-count",
        topic: "Count-based auto assignment",
        proposal: "Auto-assign 4 reviewers from routing.jsonc",
        count: 4,
        routingConfig,
        commandRunner: mockRunner,
        db,
      });
      assert.equal(resCount.verdict, "APPROVE");
      assert.equal(capturedHarnesses.length, 4);
    });

    test("unwraps Antigravity stream-json step_update deltas in parseReviewerOpening and runs debate via ACP", async () => {
      const agyStream = [
        JSON.stringify({ event: "init", conversation_id: "agy-deb-1" }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: '```json\n{"verdict":"MINOR_AMEND","hard_constraints":["Keep zero deps"],',
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: '"decisions":["Use ACP v1"],"risks":[],"reasoning":"Clean stdio RPC"}\n```',
          },
        }),
      ].join("\n");

      const parsed = parseReviewerOpening(agyStream);
      assert.ok(parsed);
      assert.equal(parsed?.verdict, "MINOR_AMEND");
      assert.deepEqual(parsed?.hard_constraints, ["Keep zero deps"]);

      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asd-deb-acp-"));
      try {
        const db = openProjectDb(projectRoot);
        openDrivers.push(db);
        const mockAcpDebate = path.join(projectRoot, "mock-acp-debate.mjs");
        fs.writeFileSync(
          mockAcpDebate,
          `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-deb-ses" } });
  } else if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-deb-ses",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ verdict: "APPROVE", hard_constraints: ["ACP verified"], decisions: [], risks: [], reasoning: "Solid" }) }
        }
      }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
          `.trim()
        );

        const debRes = await runDebateBroker({
          projectRoot,
          sessionId: "asd-20261118-020000-d001",
          topic: "ACP Debate Transport",
          proposal: "Run reviewers over ACP",
          reviewerRoutes: [{ harness: "opencode", model: "glm-5", role: "critic" }],
          acpCommandOverride: { command: process.execPath, args: [mockAcpDebate] },
          db,
        });

        assert.equal(debRes.verdict, "APPROVE");
        assert.ok(debRes.hardConstraints.includes("ACP verified"));
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe("8. Debate Hardening Regression Suite (REQ-01..REQ-06)", () => {
    test("REQ-01: REJECT verdict (normal and r2-arbiter-fallback) does not mutate tasks.acceptance or .asd/PLAN.md", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-reject-guard";
      const taskId = "T8.1";
      db.createOrGetSession({ sessionId, projectRoot, mainHarness: "claude-code" });
      db.upsertTasks(sessionId, [
        { taskId, turn: 1, title: "Protected Task", acceptance: "Original criteria only" },
      ]);

      // Case A: Normal Arbiter REJECT
      const rejectRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          const meta: SubagentSessionMeta = JSON.parse(
            fs.readFileSync(opts.env["ASD_SUBAGENT_META"] ?? "", "utf8")
          );
          opts.onSpawn?.(8101);
          if (meta.subSessionId.includes("r2-arbiter")) {
            opts.onStdout(
              JSON.stringify({
                verdict: "REJECT",
                hard_constraints: ["Blocked constraint"],
                decisions: ["Reject proposal completely"],
                risks: ["High security risk"],
                reasoning: "Unsafe design",
              })
            );
          } else {
            opts.onStdout(
              JSON.stringify({
                verdict: "REJECT",
                hard_constraints: ["R1 blocked constraint"],
                decisions: ["R1 reject"],
                risks: ["R1 risk"],
                reasoning: "Rejected in R1",
              })
            );
          }
          return { exitCode: 0, pid: 8101 };
        },
      };

      const resNormal = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-REJECT-NORMAL",
        topic: "Unsafe feature",
        proposal: "Disable all auth checks",
        commandRunner: rejectRunner,
        db,
      });

      assert.equal(resNormal.verdict, "REJECT");
      assert.equal(resNormal.updatedAcceptance, undefined);
      assert.equal(db.getTask(sessionId, taskId)?.acceptance, "Original criteria only");
      assert.equal(fs.existsSync(path.join(projectRoot, ".asd", "PLAN.md")), false);
      assert.equal(db.getDebate("D-REJECT-NORMAL")?.status, "done");

      // Case B: r2-arbiter-fallback crash REJECT
      const fallbackRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          const meta: SubagentSessionMeta = JSON.parse(
            fs.readFileSync(opts.env["ASD_SUBAGENT_META"] ?? "", "utf8")
          );
          opts.onSpawn?.(8102);
          if (meta.subSessionId.includes("r2-arbiter")) {
            opts.onStderr("Arbiter crashed unexpectedly");
            return { exitCode: 1, pid: 8102 };
          }
          opts.onStdout(
            JSON.stringify({
              verdict: meta.subSessionId.includes("r1-1") ? "REJECT" : "MINOR_AMEND",
              hard_constraints: ["Must not leak into acceptance"],
              decisions: ["Must not leak decision"],
              risks: ["Crash risk"],
              reasoning: "Conflict in R1",
            })
          );
          return { exitCode: 0, pid: 8102 };
        },
      };

      const resFallback = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-REJECT-FALLBACK",
        topic: "Arbiter crash case",
        proposal: "Trigger fallback REJECT",
        commandRunner: fallbackRunner,
        db,
      });

      assert.equal(resFallback.verdict, "REJECT");
      assert.equal(resFallback.round2Bundle?.arbiterVerdict.reviewerId, "r2-arbiter-fallback");
      assert.equal(resFallback.updatedAcceptance, undefined);
      assert.equal(db.getTask(sessionId, taskId)?.acceptance, "Original criteria only");
      assert.equal(fs.existsSync(path.join(projectRoot, ".asd", "PLAN.md")), false);
    });

    test("REQ-02: Round 2 Arbiter is sole authority for hardConstraints and decisions (discarded R1 MINOR_AMEND constraints do not resurrect)", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      let capturedR2Prompt = "";
      const mockRunner: CommandRunner = {
        async run(_cmd, args, opts) {
          const meta: SubagentSessionMeta = JSON.parse(
            fs.readFileSync(opts.env["ASD_SUBAGENT_META"] ?? "", "utf8")
          );
          opts.onSpawn?.(8201);
          if (meta.subSessionId.includes("r1-1")) {
            opts.onStdout(
              JSON.stringify({
                verdict: "REJECT",
                hard_constraints: ["R1 reject constraint"],
                decisions: ["R1 reject decision"],
                risks: ["R1 reject risk"],
                reasoning: "Disagree",
              })
            );
          } else if (meta.subSessionId.includes("r1-2")) {
            opts.onStdout(
              JSON.stringify({
                verdict: "MINOR_AMEND",
                hard_constraints: ["C1-discarded-by-arbiter"],
                decisions: ["D1-discarded-by-arbiter"],
                risks: ["R1 minor risk"],
                reasoning: "Suggest C1",
              })
            );
          } else {
            capturedR2Prompt = args.join(" ");
            opts.onStdout(
              JSON.stringify({
                verdict: "MINOR_AMEND",
                hard_constraints: ["C2-arbiter-approved"],
                decisions: ["D2-arbiter-approved"],
                risks: ["Arbiter risk"],
                reasoning: "Discarded C1/D1 after checking source code",
              })
            );
          }
          return { exitCode: 0, pid: 8201 };
        },
      };

      const res = await runDebateBroker({
        projectRoot,
        sessionId: "sess-arbiter-authority",
        debateId: "D-ARB-AUTH",
        topic: "Arbiter authority",
        proposal: "Ensure arbiter discards invalid R1 constraints",
        commandRunner: mockRunner,
        db,
      });

      assert.equal(res.verdict, "MINOR_AMEND");
      assert.deepEqual(res.hardConstraints, ["C2-arbiter-approved"]);
      assert.deepEqual(res.decisions, ["D2-arbiter-approved"]);
      assert.equal(res.hardConstraints.includes("C1-discarded-by-arbiter"), false);
      assert.equal(res.decisions.includes("D1-discarded-by-arbiter"), false);
      // Risks still preserve Round 1 audit visibility
      assert.ok(res.risks.includes("R1 reject risk"));
      assert.ok(res.risks.includes("R1 minor risk"));
      assert.ok(capturedR2Prompt.includes("NOT automatically inherited"));
    });

    test("REQ-03: parses mid-token split NDJSON deltas without newline corruption and retries non-JSON exitCode 0 within retry cap", async () => {
      // Mid-key and mid-string splits across step_update.text_delta & delta.text + trailing user echo
      const splitDeltaStream = [
        JSON.stringify({
          message: { role: "user", content: [{ type: "text", text: "Prompt echo" }] },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: { text_delta: '```json\n{"ver' },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: { text_delta: 'dict":"APPROVE","hard_const' },
        }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: 'raints":["Keep zero ' },
        }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: 'deps"],"decisions":["Use join empty"],"risks":[],"reasoning":"clean"}\n```' },
        }),
      ].join("\n");

      const parsed = parseReviewerOpening(splitDeltaStream);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "APPROVE");
      assert.deepEqual(parsed.hard_constraints, ["Keep zero deps"]);
      assert.deepEqual(parsed.decisions, ["Use join empty"]);

      // Non-JSON prose with exitCode 0 triggers fallback retry and succeeds
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      let callCount = 0;
      const retryRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          callCount++;
          opts.onSpawn?.(8301);
          if (callCount === 1) {
            opts.onStdout("Sure! Here is a plain markdown review with no JSON block.");
            return { exitCode: 0, pid: 8301 };
          }
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: ["Fallback parsed cleanly"],
              decisions: ["Retry succeeded"],
              risks: [],
              reasoning: "Valid JSON on fallback",
            })
          );
          return { exitCode: 0, pid: 8301 };
        },
      };

      const retryRes = await runDebateBroker({
        projectRoot,
        sessionId: "sess-parse-retry",
        topic: "Parse failure fallback retry",
        proposal: "Retry when model emits plain prose",
        reviewerRoutes: [{ harness: "opencode", model: "glm-5", role: "critic" }],
        commandRunner: retryRunner,
        db,
      });

      assert.equal(retryRes.verdict, "APPROVE");
      assert.equal(callCount, 2);
      assert.ok(retryRes.hardConstraints.includes("Fallback parsed cleanly"));
    });

    test("REQ-04: recomputes post-crash diversityDegraded and assigns neutral non-proposer reviewers & Arbiter", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      // Part A: 2 reviewers configured, 1 crashes -> post-run diversityDegraded must flip to true
      const crashRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          const meta: SubagentSessionMeta = JSON.parse(
            fs.readFileSync(opts.env["ASD_SUBAGENT_META"] ?? "", "utf8")
          );
          opts.onSpawn?.(8401);
          if (meta.subSessionId.includes("r1-1")) {
            opts.onStderr("Simulated crash");
            return { exitCode: 1, pid: 8401 };
          }
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: ["Survived"],
              risks: [],
              reasoning: "OK",
            })
          );
          return { exitCode: 0, pid: 8401 };
        },
      };

      const crashRes = await runDebateBroker({
        projectRoot,
        sessionId: "sess-post-degraded",
        debateId: "D-POST-DEG",
        topic: "Single survivor degradation",
        proposal: "Check post-run diversityDegraded",
        commandRunner: crashRunner,
        db,
      });

      assert.equal(crashRes.round1Bundle.openings.length, 1);
      assert.equal(crashRes.diversityDegraded, true);
      const savedInsight = JSON.parse(db.getDebate("D-POST-DEG")!.insight_verdict_json!);
      assert.equal(savedInsight.diversity_degraded, true);

      // Part B: 3+ families available -> R1 reviewers and Round 2 Arbiter avoid proposer family ('claude')
      const seenRoutes: Array<{ subId: string; harness: string; model: string }> = [];
      const diverseRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          const meta: SubagentSessionMeta = JSON.parse(
            fs.readFileSync(opts.env["ASD_SUBAGENT_META"] ?? "", "utf8")
          );
          seenRoutes.push({ subId: meta.subSessionId, harness: meta.harness, model: meta.model });
          opts.onSpawn?.(8402);
          opts.onStdout(
            JSON.stringify({
              verdict: meta.subSessionId.includes("r1-1") ? "REJECT" : "APPROVE",
              hard_constraints: [],
              decisions: ["Checked"],
              risks: [],
              reasoning: "Reviewed",
            })
          );
          return { exitCode: 0, pid: 8402 };
        },
      };

      const neutralRes = await runDebateBroker({
        projectRoot,
        sessionId: "sess-neutral-arbiter",
        topic: "Neutral arbiter assignment",
        proposal: "Ensure proposer does not arbitrate its own proposal",
        proposerRoute: { harness: "claude-code", model: "claude-opus-5-5", modelFamily: "claude" },
        commandRunner: diverseRunner,
        db,
      });

      assert.equal(neutralRes.diversityDegraded, false);
      const r1Routes = seenRoutes.filter((r) => r.subId.includes("-r1-"));
      const r2Route = seenRoutes.find((r) => r.subId.includes("r2-arbiter"));
      assert.equal(r1Routes.length, 2);
      // Neither Round 1 reviewer nor Round 2 Arbiter should be proposer's claude-code harness
      assert.ok(r1Routes.every((r) => r.harness !== "claude-code"));
      assert.ok(r2Route && r2Route.harness !== "claude-code");
    });

    test("REQ-05 & REQ-06: injects per-role lenses, truncation markers, and safe bounded Round 2 citation expansion", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      // Create a 180-line source file and a protected .env file
      const bigFile = path.join(projectRoot, "src", "large.ts");
      fs.mkdirSync(path.dirname(bigFile), { recursive: true });
      const bigLines = Array.from({ length: 180 }, (_, idx) => `export const line_${idx + 1} = ${idx + 1};`);
      fs.writeFileSync(bigFile, bigLines.join("\n"), "utf8");
      fs.writeFileSync(path.join(projectRoot, ".env"), "SECRET_TOKEN=topsecret\n", "utf8");

      // 1. Truncation marker for >150 lines
      const initialCtx = buildDebateCodeContext(projectRoot, ["src/large.ts"]);
      assert.ok(initialCtx.includes("### File: src/large.ts (Lines 1-150 of 180)"));
      assert.ok(initialCtx.includes("[... Truncated: showing lines 1-150 of 180 ...]"));
      assert.equal(initialCtx.includes("line_165"), false);

      // 2. Round 2 citation auto-expansion loads line 165 and blocks .env / traversal
      const r2Expanded = buildRound2CitedCodeContext(
        projectRoot,
        {
          openings: [
            {
              reviewerId: "r1-1",
              role: "critic",
              harness: "codex",
              model: "gpt-6-luna",
              modelFamily: "gpt",
              verdict: "REJECT",
              hard_constraints: [],
              decisions: [],
              risks: [],
              reasoning: "Check src/large.ts:165 and also .env:1 and ../outside.ts:10",
            },
          ],
          failedReviewers: [],
        },
        ["src/large.ts"]
      );
      assert.ok(r2Expanded.includes("165: export const line_165 = 165;"));
      assert.equal(r2Expanded.includes("SECRET_TOKEN"), false);
      assert.equal(r2Expanded.includes("outside.ts"), false);

      // 3. Per-role review lenses are distinct for critic vs architect
      const promptsByRole = new Map<string, string>();
      const roleRunner: CommandRunner = {
        async run(_cmd, args, opts) {
          const meta: SubagentSessionMeta = JSON.parse(
            fs.readFileSync(opts.env["ASD_SUBAGENT_META"] ?? "", "utf8")
          );
          promptsByRole.set(meta.role, args.join(" "));
          opts.onSpawn?.(8501);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: [],
              risks: [],
              reasoning: "Role reviewed",
            })
          );
          return { exitCode: 0, pid: 8501 };
        },
      };

      const roleRes = await runDebateBroker({
        projectRoot,
        sessionId: "sess-role-lenses",
        topic: "Role-specific prompts",
        proposal: "Verify orthogonal review lenses",
        files: ["src/large.ts"],
        reviewerRoutes: [
          { harness: "codex", model: "gpt-6-luna", role: "critic" },
          { harness: "opencode", model: "z-ai/glm-5.3-flash", role: "architect" },
        ],
        commandRunner: roleRunner,
        db,
      });

      assert.equal(roleRes.verdict, "APPROVE");
      assert.ok(promptsByRole.get("critic")?.includes("## Role-Specific Review Lens (critic)"));
      assert.ok(promptsByRole.get("architect")?.includes("## Role-Specific Review Lens (architect)"));
      assert.notEqual(promptsByRole.get("critic"), promptsByRole.get("architect"));
    });
  });
});
