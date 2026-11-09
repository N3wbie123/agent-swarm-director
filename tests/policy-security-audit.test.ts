import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { evaluatePreToolUse } from "../src/core/policy.ts";
import { AsdMcpServer } from "../src/mcp/server.ts";
import { main as cliMain } from "../src/cli/index.ts";
import { openProjectDb, type SqliteDriver } from "../src/core/db.ts";

describe("Security Policy, Subagent Guard, Orphan Recovery & Secret Fixture Audit (T2.2)", () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteDriver[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-sec-audit-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("1. Subagent guard blocks orchestration commands in both CLI and MCP server", async () => {
    const root = makeTempDir();
    const home = makeTempDir();
    const prevRole = process.env.ASD_SESSION_ROLE;

    try {
      process.env.ASD_SESSION_ROLE = "subagent";

      // MCP server blocks asd_plan, asd_dispatch, asd_debate
      const server = new AsdMcpServer({
        projectRoot: root,
        homeDir: home,
        sessionRole: "subagent",
      });
      try {
        await assert.rejects(
          () => server.handlePlan({ action: "get" }),
          /Subagents cannot invoke orchestration tools/
        );
        await assert.rejects(
          () => server.handleDispatch({ sessionId: "asd-20261109-000000-test" }),
          /Subagents cannot invoke orchestration tools/
        );
        await assert.rejects(
          () =>
            server.handleDebate({
              sessionId: "asd-20261109-000000-test",
              topic: "t",
              proposal: "p",
            }),
          /Subagents cannot invoke orchestration tools/
        );
      } finally {
        server.close();
      }

      // CLI entrypoints return exitCode 1 when ASD_SESSION_ROLE=subagent
      for (const cmd of ["plan", "dispatch", "debate", "clean", "sync", "uninstall"]) {
        const code = await cliMain([cmd, "--project-root", root, "--home", home]);
        assert.equal(code, 1, `Expected CLI '${cmd}' to fail for subagent`);
      }
    } finally {
      if (prevRole === undefined) {
        delete process.env.ASD_SESSION_ROLE;
      } else {
        process.env.ASD_SESSION_ROLE = prevRole;
      }
    }
  });

  test("2. handlePlan(action='get') does not overwrite PLAN.md and recovers dead parallel_spawn orphans", async () => {
    const root = makeTempDir();
    const home = makeTempDir();
    const server = new AsdMcpServer({
      projectRoot: root,
      homeDir: home,
      autoSync: false,
    });

    try {
      const created = await server.handlePlan({
        action: "create",
        title: "Read-only get & orphan check",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Orphaned task",
            targetFiles: ["src/a.ts"],
          },
        ],
      });
      const sessionId = created.sessionId;
      const planMdPath = created.planMdPath;

      // Simulate user local comment/modification in PLAN.md
      const customContent = fs.readFileSync(planMdPath, "utf8") + "\n<!-- USER_LOCAL_EDIT -->\n";
      fs.writeFileSync(planMdPath, customContent, "utf8");

      // Simulate a dead parallel_spawn running task
      const db = openProjectDb(root, home);
      openDbs.push(db);
      const subId = "1-T1.1-dead";
      db.updateTaskStatus(sessionId, "T1.1", "running", { subSessionId: subId });
      const subDir = path.join(root, ".asd", "sessions", sessionId, "subagents", subId);
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, "meta.json"),
        JSON.stringify({
          subSessionId: subId,
          sessionId,
          taskId: "T1.1",
          role: "worker",
          harness: "claude-code",
          model: "sonnet",
          track: "LIGHT",
          allowedFiles: ["src/a.ts"],
          startedAt: Date.now() - 60_000,
          status: "running",
          dispatchMode: "parallel_spawn",
          pid: 99999999,
          ownerPid: 99999998,
        }),
        "utf8"
      );

      const getRes = await server.handlePlan({ action: "get", sessionId });
      // 1. User's local PLAN.md edit must remain intact
      assert.equal(fs.readFileSync(planMdPath, "utf8"), customContent);
      // 2. Dead parallel_spawn task is recovered to failed
      assert.equal(getRes.tasks[0]?.status, "failed");
    } finally {
      server.close();
    }
  });

  test("3. evaluatePreToolUse blocks quote-split .git and .env bypasses while allowing benign env references", () => {
    const root = makeTempDir();
    const metaPath = path.join(root, "meta.json");
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        subSessionId: "sub-1",
        sessionId: "asd-20261109-000000-sec",
        taskId: "T1.1",
        role: "worker",
        harness: "claude-code",
        model: "sonnet",
        track: "LIGHT",
        allowedFiles: ["src/**"],
        startedAt: Date.now(),
        status: "running",
      }),
      "utf8"
    );

    const subEnv = {
      ASD_SESSION_ROLE: "subagent",
      ASD_SUBAGENT_META: metaPath,
      ASD_PROJECT_ROOT: root,
    };

    // Quote-escaped .git config read in main session
    assert.equal(
      evaluatePreToolUse(
        { tool_name: "Bash", tool_input: { command: 'cat ".git"/config' } },
        undefined,
        {}
      ).allowed,
      false
    );

    // Chained command targeting .git in main session
    assert.equal(
      evaluatePreToolUse(
        { tool_name: "Bash", tool_input: { command: "echo ok && ls .git" } },
        undefined,
        {}
      ).allowed,
      false
    );

    // Subagent .env and quote-split ".env" blocked
    assert.equal(
      evaluatePreToolUse(
        { tool_name: "Bash", tool_input: { command: "cat .env.production" } },
        undefined,
        subEnv
      ).allowed,
      false
    );
    assert.equal(
      evaluatePreToolUse(
        { tool_name: "Bash", tool_input: { command: 'cat "."env' } },
        undefined,
        subEnv
      ).allowed,
      false
    );

    // Subagent benign process.env and .env.example allowed
    assert.equal(
      evaluatePreToolUse(
        { tool_name: "Bash", tool_input: { command: 'node -e "console.log(process.env.NODE_ENV)"' } },
        undefined,
        subEnv
      ).allowed,
      true
    );
    assert.equal(
      evaluatePreToolUse(
        { tool_name: "Bash", tool_input: { command: "cat .env.example" } },
        undefined,
        subEnv
      ).allowed,
      true
    );
  });

  test("4. test suite files contain zero raw GitHub Secret Scanning literal tokens", () => {
    const testsDir = path.resolve(process.cwd(), "tests");
    const files = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));
    const rawScannerRegex = new RegExp(
      [
        "\\bAKIA[0-9A-Z]{16}\\b",
        "\\bASIA[0-9A-Z]{16}\\b",
        "\\bsk-proj-[A-Za-z0-9_-]{20,}\\b",
        "\\bsk-ant-[A-Za-z0-9_-]{15,}\\b",
        "\\bghp_[A-Za-z0-9]{20,}\\b",
        "\\bAIza[0-9A-Za-z_-]{20,}\\b",
      ].join("|")
    );

    for (const file of files) {
      const content = fs.readFileSync(path.join(testsDir, file), "utf8");
      assert.equal(
        rawScannerRegex.test(content),
        false,
        `Test file ${file} should not contain raw literal secret scanner patterns`
      );
    }
  });
});
