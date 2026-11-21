import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as child_process from "node:child_process";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../src/core/db.ts";
import { buildOpenCodeCapabilityProfile } from "../src/core/opencode-profile.ts";
import {
  buildHeadlessHarnessCommand,
  buildResumeHarnessCommand,
  buildSessionDemotion,
  buildSpawnSpec,
  discoverProjectCliSessions,
  extractHarnessSessionIdFromOutput,
  getCliRecentSessionsPath,
  linkHarnessSessionToAsdSession,
  listKnownProjects,
  promoteCliSessionToAsd,
  readCliRecentSessions,
  recordCliRecentSession,
  syncLocalHarnessTranscripts,
  unlinkHarnessSessionFromAsdSession,
} from "../src/core/session-tracker.ts";

function makeTempDir(prefix = "asd-session-tracker-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("T1.1: syncLocalHarnessTranscripts discovers Claude Code, Codex, OpenCode, and Antigravity sessions for projectRoot", () => {
  const homeDir = makeTempDir("asd-t11-home-");
  const projectRoot = makeTempDir("asd-t11-proj-");
  const otherProjectRoot = makeTempDir("asd-t11-other-");
  try {
    fs.mkdirSync(path.join(projectRoot, ".asd"), { recursive: true });

    // 1. Claude Code transcript under ~/.claude/projects/<encoded>/cc-sess-1.jsonl
    const encodedDir = projectRoot.replace(/[:\\/]/g, "-");
    const claudeDir = path.join(homeDir, ".claude", "projects", encodedDir);
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeTranscript = path.join(claudeDir, "cc-sess-101.jsonl");
    fs.writeFileSync(
      claudeTranscript,
      [
        JSON.stringify({
          type: "user",
          cwd: projectRoot,
          message: { role: "user", content: "Fix authentication bug in login flow" },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "On it." }] },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    // 2. Codex rollout transcript under ~/.codex/sessions/2026/11/03/rollout-...-codex-thread-202.jsonl
    const codexDir = path.join(homeDir, ".codex", "sessions", "2026", "11", "03");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexTranscript = path.join(
      codexDir,
      "rollout-2026-11-03T10-00-00-codex-thread-202.jsonl"
    );
    fs.writeFileSync(
      codexTranscript,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-thread-202", cwd: projectRoot, model: "gpt-5.4" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>skip me</environment_context>" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Optimize database queries for Codex" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    // Unrelated Codex session for otherProjectRoot (must be ignored)
    fs.writeFileSync(
      path.join(codexDir, "rollout-2026-11-03T10-00-00-codex-other-999.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-other-999", cwd: otherProjectRoot },
      }) + "\n",
      "utf8"
    );

    // 3. OpenCode SQLite session in ~/.local/share/opencode/opencode.db
    const ocDir = path.join(homeDir, ".local", "share", "opencode");
    fs.mkdirSync(ocDir, { recursive: true });
    const ocDbPath = path.join(ocDir, "opencode.db");
    const ocDb = new DatabaseSync(ocDbPath);
    ocDb.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        title TEXT,
        parent_id TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
    `);
    const nowMs = Date.now();
    ocDb
      .prepare("INSERT INTO project (id, worktree) VALUES (?, ?)")
      .run("proj-1", projectRoot);
    ocDb
      .prepare(
        "INSERT INTO session (id, project_id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("oc-sess-303", "proj-1", projectRoot, "Refactor OpenCode router", null, nowMs - 1000, nowMs);
    ocDb.close();

    // 4. Antigravity transcript under ~/.gemini/antigravity-cli/brain/agy-conv-404/.system_generated/logs/transcript.jsonl
    const agyLogDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      "agy-conv-404",
      ".system_generated",
      "logs"
    );
    fs.mkdirSync(agyLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(agyLogDir, "transcript.jsonl"),
      JSON.stringify({
        type: "USER_INPUT",
        content: `<CONTEXT_SUMMARY>old context</CONTEXT_SUMMARY><USER_REQUEST>Build Antigravity session sync</USER_REQUEST><ADDITIONAL_METADATA>workspace: ${projectRoot}</ADDITIONAL_METADATA>`,
      }) + "\n",
      "utf8"
    );

    const synced = syncLocalHarnessTranscripts(projectRoot, { homeDir });
    const byHarness = new Map(synced.map((s) => [s.harness, s]));

    assert.equal(byHarness.get("claude-code")?.harnessSessionId, "cc-sess-101");
    assert.equal(byHarness.get("claude-code")?.model, "claude-sonnet-4-6");
    assert.equal(byHarness.get("claude-code")?.summary, "Fix authentication bug in login flow");

    assert.equal(byHarness.get("codex")?.harnessSessionId, "codex-thread-202");
    assert.equal(byHarness.get("codex")?.model, "gpt-5.4");
    assert.equal(byHarness.get("codex")?.summary, "Optimize database queries for Codex");

    assert.equal(byHarness.get("opencode")?.harnessSessionId, "oc-sess-303");
    assert.equal(byHarness.get("opencode")?.summary, "Refactor OpenCode router");

    assert.equal(byHarness.get("antigravity")?.harnessSessionId, "agy-conv-404");
    assert.equal(byHarness.get("antigravity")?.summary, "Build Antigravity session sync");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(otherProjectRoot, { recursive: true, force: true });
  }
});

test("T1.1: recordCliRecentSession preserves meaningful summary and transcriptPath across tool/stop hooks", () => {
  const projectRoot = makeTempDir("asd-t11-record-");
  try {
    fs.mkdirSync(path.join(projectRoot, ".asd"), { recursive: true });

    recordCliRecentSession(projectRoot, {
      harnessSessionId: "sess-preserve-1",
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      summary: "Initial user prompt for feature X",
      transcriptPath: "/tmp/transcript-1.jsonl",
    });

    // Subsequent pre-tool-use with generic "Tool: Bash" and no transcriptPath
    const afterTool = recordCliRecentSession(projectRoot, {
      harnessSessionId: "sess-preserve-1",
      harness: "claude-code",
      summary: "Tool: Bash",
      transcriptPath: null,
    });
    assert.equal(afterTool?.summary, "Initial user prompt for feature X");
    assert.equal(afterTool?.transcriptPath, "/tmp/transcript-1.jsonl");
    assert.equal(afterTool?.model, "claude-sonnet-4-6");

    // Subsequent stop hook with empty summary
    const afterStop = recordCliRecentSession(projectRoot, {
      harnessSessionId: "sess-preserve-1",
      harness: "claude-code",
      summary: "",
      transcriptPath: undefined,
    });
    assert.equal(afterStop?.summary, "Initial user prompt for feature X");
    assert.equal(afterStop?.transcriptPath, "/tmp/transcript-1.jsonl");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T1.1: linkHarnessSessionToAsdSession falls back to syncLocalHarnessTranscripts when cli-recent has no fresh entry for target harness", () => {
  const homeDir = makeTempDir("asd-t11-link-home-");
  const projectRoot = makeTempDir("asd-t11-link-proj-");
  try {
    const db = openProjectDb(projectRoot, homeDir);
    const asdSessionId = "asd-20261103-183000-t11a";
    db.createOrGetSession({
      sessionId: asdSessionId,
      projectRoot,
      mainHarness: "codex",
      mainModel: "gpt-5.4",
    });

    // Seed an old claude-code entry in cli-recent.json so the file is non-empty
    recordCliRecentSession(
      projectRoot,
      {
        harnessSessionId: "old-cc-1",
        harness: "claude-code",
        summary: "Old session",
      },
      { forceCreateDir: true }
    );

    // Create a fresh local Codex rollout transcript for projectRoot
    const codexDir = path.join(homeDir, ".codex", "sessions", "2026", "11", "03");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "rollout-2026-11-03T18-30-00-codex-fresh-777.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-fresh-777", cwd: projectRoot, model: "gpt-5.4" },
      }) + "\n",
      "utf8"
    );

    const linked = linkHarnessSessionToAsdSession({
      projectRoot,
      homeDir,
      asdSessionId,
      harness: "codex",
      db,
    });

    assert.equal(linked.harnessSessionId, "codex-fresh-777");
    const activeDriver = db.getActiveDriver(asdSessionId);
    assert.equal(activeDriver?.harness, "codex");
    assert.equal(activeDriver?.harness_session_id, "codex-fresh-777");
    db.close();
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T2.2: promoteCliSessionToAsd promotes a plain CLI session into an ASD session and round-trips with buildSessionDemotion", () => {
  const homeDir = makeTempDir("asd-t22-promo-home-");
  const projectRoot = makeTempDir("asd-t22-promo-proj-");
  try {
    const promoted = promoteCliSessionToAsd({
      projectRoot,
      homeDir,
      harness: "antigravity",
      harnessSessionId: "agy-conv-promo-888",
      model: "gemini-3.1-pro-high",
      title: "Promote CLI session test",
      autoApprove: true,
    });

    assert.ok(promoted.asdSessionId.startsWith("asd-"));
    assert.ok(promoted.driverId.startsWith("drv-"));
    assert.equal(promoted.harness, "antigravity");
    assert.equal(promoted.harnessSessionId, "agy-conv-promo-888");
    assert.ok(fs.existsSync(promoted.mainJsonPath));

    const recent = readCliRecentSessions(projectRoot);
    assert.equal(recent[0]?.harnessSessionId, "agy-conv-promo-888");
    assert.equal(recent[0]?.asdSessionId, promoted.asdSessionId);

    // Demoting back to CLI session must return `agy --conversation agy-conv-promo-888`
    const demoted = buildSessionDemotion({
      projectRoot,
      homeDir,
      sessionId: promoted.asdSessionId,
    });
    assert.equal(demoted.command, "agy");
    assert.deepEqual(demoted.args, ["--conversation", "agy-conv-promo-888", "--model", "gemini-3.1-pro-high"]);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T2.3: discoverProjectCliSessions finds CLI sessions even without .asd dir and enriches promoted asdSessionId, while listKnownProjects supports skipDiskCheck", () => {
  const homeDir = makeTempDir("asd-t23-home-");
  const projectRoot = makeTempDir("asd-t23-proj-");
  try {
    // 1. Create a Claude Code transcript for projectRoot WITHOUT creating <projectRoot>/.asd first
    const encodedDir = projectRoot.replace(/[:\\/]/g, "-");
    const claudeDir = path.join(homeDir, ".claude", "projects", encodedDir);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "cc-no-asd-500.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: projectRoot,
        message: { role: "user", content: "Explore project before ASD init" },
      }) + "\n",
      "utf8"
    );

    const beforeAsdInit = discoverProjectCliSessions(projectRoot, { homeDir });
    assert.equal(beforeAsdInit.length, 1);
    assert.equal(beforeAsdInit[0]?.harness, "claude-code");
    assert.equal(beforeAsdInit[0]?.harnessSessionId, "cc-no-asd-500");
    assert.equal(beforeAsdInit[0]?.asdSessionId, null);

    // 2. Promote that CLI session to ASD and re-run discoverProjectCliSessions
    const promo = promoteCliSessionToAsd({
      projectRoot,
      homeDir,
      harness: "claude-code",
      harnessSessionId: "cc-no-asd-500",
      model: "claude-sonnet-4-6",
    });

    const afterPromo = discoverProjectCliSessions(projectRoot, { homeDir });
    assert.equal(afterPromo[0]?.harnessSessionId, "cc-no-asd-500");
    assert.equal(afterPromo[0]?.asdSessionId, promo.asdSessionId);

    // 3. listKnownProjects with skipDiskCheck returns project summary quickly
    const projects = listKnownProjects({ homeDir, skipDiskCheck: true });
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.latestSessionId, promo.asdSessionId);

    // 4. findSessionByHarnessSessionId finds the promoted session in DB
    const db = openProjectDb(projectRoot, homeDir);
    try {
      const found = db.findSessionByHarnessSessionId("cc-no-asd-500", "claude-code");
      assert.equal(found?.session_id, promo.asdSessionId);

      // 5. unlinkHarnessSessionFromAsdSession detaches active driver & resets asdSessionId: null in cli-recent.json
      const unlinked = unlinkHarnessSessionFromAsdSession({
        projectRoot,
        homeDir,
        asdSessionId: promo.asdSessionId,
        db,
      });
      assert.equal(unlinked.unlinked, true);
      assert.equal(unlinked.harnessSessionId, "cc-no-asd-500");

      const afterUnlink = discoverProjectCliSessions(projectRoot, { homeDir, db });
      assert.equal(afterUnlink[0]?.harnessSessionId, "cc-no-asd-500");
      assert.equal(afterUnlink[0]?.asdSessionId, null);

      // 6. deleteSession cascade-deletes the session and its drivers
      const deleted = db.deleteSession(promo.asdSessionId);
      assert.equal(deleted, true);
      assert.equal(db.getSession(promo.asdSessionId), undefined);
      assert.equal(db.listDrivers(promo.asdSessionId).length, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T5.1: discoverProjectCliSessions enriches from core.db harness_session_id when cli-recent.json is absent", () => {
  const homeDir = makeTempDir("asd-t51-home-");
  const projectRoot = makeTempDir("asd-t51-proj-");
  try {
    // 1. Create a local Claude Code transcript for projectRoot
    const encodedDir = projectRoot.replace(/[:\\/]/g, "-");
    const claudeDir = path.join(homeDir, ".claude", "projects", encodedDir);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "cc-db-enrich-601.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: projectRoot,
        message: { role: "user", content: "Transcript session to enrich from DB" },
      }) + "\n",
      "utf8"
    );

    const db = openProjectDb(projectRoot, homeDir);
    try {
      // Link existing transcript session in core.db
      db.createOrGetSession({
        sessionId: "asd-20261104-170000-db01",
        projectRoot,
        mainHarness: "claude-code",
        mainModel: "claude-sonnet-4-6",
        harnessSessionId: "cc-db-enrich-601",
        memo: "DB memo for cc-db-enrich-601",
      });

      // Also create a DB-only linked session (no local transcript file and no cli-recent.json)
      db.createOrGetSession({
        sessionId: "asd-20261104-170100-db02",
        projectRoot,
        mainHarness: "codex",
        mainModel: "gpt-5.4",
        harnessSessionId: "codex-db-only-602",
        memo: "DB-only linked Codex session",
      });

      // Ensure cli-recent.json does not exist
      const recentPath = getCliRecentSessionsPath(projectRoot);
      if (fs.existsSync(recentPath)) {
        fs.unlinkSync(recentPath);
      }

      const discovered = discoverProjectCliSessions(projectRoot, {
        homeDir,
        db,
        persist: false,
      });

      const byHarnessId = new Map(discovered.map((s) => [s.harnessSessionId, s]));

      const enrichedTranscript = byHarnessId.get("cc-db-enrich-601");
      assert.ok(enrichedTranscript, "Expected transcript session cc-db-enrich-601 to be discovered");
      assert.equal(enrichedTranscript.asdSessionId, "asd-20261104-170000-db01");
      assert.equal(enrichedTranscript.model, "claude-sonnet-4-6");

      const dbOnly = byHarnessId.get("codex-db-only-602");
      assert.ok(dbOnly, "Expected DB-only session codex-db-only-602 to be returned from core.db");
      assert.equal(dbOnly.harness, "codex");
      assert.equal(dbOnly.asdSessionId, "asd-20261104-170100-db02");
      assert.equal(dbOnly.model, "gpt-5.4");
      assert.equal(dbOnly.summary, "DB-only linked Codex session");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("F17: concurrent child processes calling recordCliRecentSession preserve all entries without loss", async () => {
  const projectRoot = makeTempDir("asd-f17-concurrent-");
  try {
    fs.mkdirSync(path.join(projectRoot, ".asd"), { recursive: true });
    const trackerUrl = new URL("../src/core/session-tracker.ts", import.meta.url).href;

    const spawnWriter = (workerPrefix: string, count: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const script = `
          import { recordCliRecentSession } from ${JSON.stringify(trackerUrl)};
          const root = ${JSON.stringify(projectRoot)};
          const prefix = ${JSON.stringify(workerPrefix)};
          for (let i = 0; i < ${count}; i++) {
            recordCliRecentSession(root, {
              harnessSessionId: prefix + "-" + i,
              harness: "claude-code",
              model: "claude-sonnet-4-6",
              summary: "Summary for " + prefix + "-" + i,
            });
          }
        `;
        const child = child_process.spawn(
          process.execPath,
          ["--no-warnings", "--input-type=module", "-e", script],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Child ${workerPrefix} exited with ${code}: ${stderr}`));
});
});

describe("S3: extractHarnessSessionIdFromOutput - tool result echoes should not pollute session IDs", () => {
  it("S3: tool result echo containing session_id should NOT be extracted as harness session id", () => {
    const toolResultEcho = JSON.stringify({
      type: "tool_result",
      tool_name: "get_session_info",
      content: JSON.stringify({ session_id: "fake-session-from-tool-result", data: "..." }),
      tool_call_id: "call-abc",
    });

    const extracted = extractHarnessSessionIdFromOutput(toolResultEcho, "claude-code");
    assert.equal(extracted, null, "Tool result echo with session_id should not be extracted");
  });

  it("S3: real Claude Code result/init envelope with session_id SHOULD be extracted", () => {
    const realEnvelope = JSON.stringify({
      type: "result",
      result: "Task completed.",
      session_id: "real-claude-session-123",
    });

    const extracted = extractHarnessSessionIdFromOutput(realEnvelope, "claude-code");
    assert.equal(extracted, "real-claude-session-123", "Real Claude envelope session_id should be extracted");
  });

  it("S3: real Codex session_configured envelope with id SHOULD be extracted", () => {
    const realEnvelope = JSON.stringify({
      type: "session_configured",
      payload: { id: "codex-thread-456", cwd: "/project", model: "gpt-5" },
    });

    const extracted = extractHarnessSessionIdFromOutput(realEnvelope, "codex");
    assert.equal(extracted, "codex-thread-456", "Real Codex session_configured id should be extracted");
  });

  it("S3: real OpenCode part envelope with session_id SHOULD be extracted", () => {
    const realEnvelope = JSON.stringify({
      part: { type: "text", text: "Hello", session_id: "oc-sess-789" },
    });

    const extracted = extractHarnessSessionIdFromOutput(realEnvelope, "opencode");
    assert.equal(extracted, "oc-sess-789", "Real OpenCode part session_id should be extracted");
  });

  it("S3: real Antigravity init/result envelope with session_id SHOULD be extracted", () => {
    const realEnvelope = JSON.stringify({
      event: "init",
      session_id: "agy-conv-999",
    });

    const extracted = extractHarnessSessionIdFromOutput(realEnvelope, "antigravity");
    assert.equal(extracted, "agy-conv-999", "Real Antigravity init session_id should be extracted");
  });

  it("S3: bare session announcement JSON without tool-result markers IS extracted (harness contract)", () => {
    const bare = JSON.stringify({
      type: "system",
      session_id: "bare-session-123",
    });

    const extracted = extractHarnessSessionIdFromOutput(bare, "claude-code");
    assert.equal(extracted, "bare-session-123", "Bare harness session announcements must be extracted (CR-03/F16 contract)");
  });

  it("S3: type-less session announcement JSON IS extracted", () => {
    const typeless = JSON.stringify({
      session_id: "cc-sess-001",
      text: "output",
    });

    const extracted = extractHarnessSessionIdFromOutput(typeless, "claude-code");
    assert.equal(extracted, "cc-sess-001", "Type-less session announcements must be extracted");
  });
});

    const perProcessCount = 15;
    await Promise.all([
      spawnWriter("procA", perProcessCount),
      spawnWriter("procB", perProcessCount),
    ]);

    const recorded = readCliRecentSessions(projectRoot);
    assert.equal(
      recorded.length,
      perProcessCount * 2,
      `Expected all ${perProcessCount * 2} concurrent entries to be preserved, got ${recorded.length}`
    );
    const ids = new Set(recorded.map((r) => r.harnessSessionId));
    for (let i = 0; i < perProcessCount; i++) {
      assert.ok(ids.has(`procA-${i}`), `Missing procA-${i}`);
      assert.ok(ids.has(`procB-${i}`), `Missing procB-${i}`);
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("T1.2: buildSpawnSpec CLI Fallback Hardening", () => {
  it("defaults streaming to true, uses V2 --auto vs V1 --pure on opencode, permission flags on agy/claude/codex, and omits model='default' on non-cursor harnesses", () => {
    const ocV2 = buildSpawnSpec({
      harness: "opencode",
      prompt: "run task",
      model: "default",
      env: { ASD_OPENCODE_PROFILE: "v2" },
    });
    assert.ok(ocV2.args.includes("--auto"), "opencode V2 headless should include --auto");
    assert.ok(!ocV2.args.includes("--pure"), "opencode V2 headless must omit --pure");
    assert.ok(!ocV2.args.includes("--model"), "model='default' must be omitted on opencode");
    assert.equal(ocV2.closeStdinOnSpawn, true);

    const ocV1 = buildSpawnSpec({
      harness: "opencode",
      prompt: "run task",
      model: "default",
      env: { ASD_OPENCODE_PROFILE: "v1" },
    });
    assert.ok(ocV1.args.includes("--pure"), "opencode V1 headless should include --pure");
    assert.ok(!ocV1.args.includes("--auto"), "opencode V1 headless must not include --auto");
    assert.ok(!ocV1.args.includes("--model"), "model='default' must be omitted on opencode");
    assert.equal(ocV1.closeStdinOnSpawn, true);

    const agy = buildSpawnSpec({
      harness: "antigravity",
      prompt: "run agy",
      model: "default",
    });
    assert.ok(agy.args.includes("stream-json"), "agy buildSpawnSpec should default to stream-json");
    assert.ok(agy.args.includes("--dangerously-skip-permissions"));
    assert.ok(!agy.args.includes("--model"));
    assert.equal(agy.closeStdinOnSpawn, true);

    const cx = buildSpawnSpec({
      harness: "codex",
      prompt: "run codex",
      model: "default",
    });
    assert.ok(
      cx.args.includes("--dangerously-bypass-approvals-and-sandbox"),
      "codex buildSpawnSpec should include --dangerously-bypass-approvals-and-sandbox"
    );
    assert.ok(!cx.args.includes("--full-auto"));
    assert.ok(!cx.args.includes("-m"));
    assert.equal(cx.closeStdinOnSpawn, true);

    const cur = buildHeadlessHarnessCommand({
      harness: "cursor",
      prompt: "run cursor",
      model: "default",
    });
    assert.ok(cur.args.includes("--model") && cur.args.includes("default"), "cursor preserves model='default'");
  });

  it("applies OpenCodeCapabilityProfile (V2 --auto vs V1/unknown --pure) across buildHeadlessHarnessCommand, buildResumeHarnessCommand, and buildSpawnSpec", () => {
    const v2Profile = buildOpenCodeCapabilityProfile({
      rawOutput: "opencode v2.3.2",
      version: "2.3.2",
      major: 2,
      pluginApi: "v2",
      source: "cli-probe",
    });
    const v1Profile = buildOpenCodeCapabilityProfile({
      rawOutput: "1.19.4",
      version: "1.19.4",
      major: 1,
      pluginApi: "v1",
      source: "cli-probe",
    });
    const unknownProfile = buildOpenCodeCapabilityProfile({
      rawOutput: null,
      version: null,
      major: null,
      pluginApi: "unknown",
      source: "fallback",
    });

    const headlessV2 = buildHeadlessHarnessCommand({
      harness: "opencode",
      prompt: "do v2",
      openCodeProfile: v2Profile,
      pure: true, // even if caller asks for pure, V2 must emit --auto and never --pure
    });
    assert.ok(headlessV2.args.includes("--auto"));
    assert.ok(!headlessV2.args.includes("--pure"));

    const headlessV2NoAuto = buildHeadlessHarnessCommand({
      harness: "opencode",
      prompt: "do v2 manual",
      openCodeProfile: v2Profile,
      skipPermissions: false,
    });
    assert.ok(!headlessV2NoAuto.args.includes("--auto"));
    assert.ok(!headlessV2NoAuto.args.includes("--pure"));

    const headlessV1 = buildHeadlessHarnessCommand({
      harness: "opencode",
      prompt: "do v1",
      openCodeProfile: v1Profile,
    });
    assert.ok(headlessV1.args.includes("--pure"));
    assert.ok(!headlessV1.args.includes("--auto"));

    const headlessUnknown = buildHeadlessHarnessCommand({
      harness: "opencode",
      prompt: "do unknown",
      openCodeProfile: unknownProfile,
    });
    assert.ok(headlessUnknown.args.includes("--pure"));
    assert.ok(!headlessUnknown.args.includes("--auto"));

    const resumeV2 = buildResumeHarnessCommand({
      harness: "opencode",
      harnessSessionId: "ses_v2_abc",
      prompt: "continue v2",
      openCodeProfile: v2Profile,
    });
    assert.ok(resumeV2.args.includes("--session") && resumeV2.args.includes("ses_v2_abc"));
    assert.ok(resumeV2.args.includes("--auto"));
    assert.ok(!resumeV2.args.includes("--pure"));

    const resumeV1 = buildResumeHarnessCommand({
      harness: "opencode",
      harnessSessionId: "ses_v1_abc",
      prompt: "continue v1",
      env: { ASD_OPENCODE_PROFILE: "v1" },
    });
    assert.ok(resumeV1.args.includes("--session") && resumeV1.args.includes("ses_v1_abc"));
    assert.ok(resumeV1.args.includes("--pure"));
    assert.ok(!resumeV1.args.includes("--auto"));

    const spawnResumeV2 = buildSpawnSpec({
      harness: "opencode",
      prompt: "resume via spawnSpec",
      resumeSessionId: "ses_v2_xyz",
      env: { ASD_OPENCODE_PROFILE: "v2" },
    });
    assert.ok(spawnResumeV2.args.includes("--auto"));
    assert.ok(!spawnResumeV2.args.includes("--pure"));
  });
});

describe("T4.3: OpenCode V2 session_v2 discovery & deduplication", () => {
  it("discovers sessions from V2-only session_v2 table and skips subagent rows", () => {
    const homeDir = makeTempDir("asd-oc-v2-only-home-");
    const projectRoot = makeTempDir("asd-oc-v2-only-proj-");
    const otherRoot = makeTempDir("asd-oc-v2-only-other-");
    try {
      const ocDir = path.join(homeDir, ".local", "share", "opencode");
      fs.mkdirSync(ocDir, { recursive: true });
      const db = new DatabaseSync(path.join(ocDir, "opencode.db"));
      db.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
        CREATE TABLE session_v2 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_id TEXT,
          directory TEXT NOT NULL,
          title TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        );
      `);
      const now = Date.now();
      db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("p1", projectRoot);
      db.prepare(
        "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("ses_v2_main_1", "p1", null, projectRoot, "V2 session title", now - 2000, now - 500);
      db.prepare(
        "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("ses_v2_sub_1", "p1", "ses_v2_main_1", projectRoot, "Subagent must skip", now - 1000, now);
      db.prepare(
        "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("ses_v2_other_1", "p2", null, otherRoot, "Other dir must skip", now - 1000, now);
      db.close();

      const discovered = discoverProjectCliSessions(projectRoot, {
        homeDir,
        harnesses: ["opencode"],
        persist: false,
      });
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0]?.harness, "opencode");
      assert.equal(discovered[0]?.harnessSessionId, "ses_v2_main_1");
      assert.equal(discovered[0]?.summary, "V2 session title");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("queries both session_v2 and legacy session tables and deduplicates by id preferring newer time_updated or session_v2", () => {
    const homeDir = makeTempDir("asd-oc-both-home-");
    const projectRoot = makeTempDir("asd-oc-both-proj-");
    try {
      const ocDir = path.join(homeDir, ".local", "share", "opencode");
      fs.mkdirSync(ocDir, { recursive: true });
      const db = new DatabaseSync(path.join(ocDir, "opencode.db"));
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          directory TEXT NOT NULL,
          title TEXT NOT NULL,
          parent_id TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        );
        CREATE TABLE session_v2 (
          id TEXT PRIMARY KEY,
          directory TEXT NOT NULL,
          title TEXT,
          parent_id TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        );
      `);
      const base = 1790000000000;
      // 1. Legacy-only session
      db.prepare(
        "INSERT INTO session (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_legacy_only", projectRoot, "Legacy only session", null, base, base + 100);

      // 2. V2-only session
      db.prepare(
        "INSERT INTO session_v2 (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_v2_only", projectRoot, "V2 only session", null, base, base + 200);

      // 3. Overlapping id where session_v2 has newer time_updated
      db.prepare(
        "INSERT INTO session (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_overlap_v2_newer", projectRoot, "Old V1 title", null, base, base + 300);
      db.prepare(
        "INSERT INTO session_v2 (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_overlap_v2_newer", projectRoot, "New V2 title", null, base, base + 500);

      // 4. Overlapping id with equal time_updated -> session_v2 preferred
      db.prepare(
        "INSERT INTO session (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_overlap_tie", projectRoot, "Tie V1 title", null, base, base + 400);
      db.prepare(
        "INSERT INTO session_v2 (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_overlap_tie", projectRoot, "Tie V2 title", null, base, base + 400);

      // 5. Overlapping id where legacy session has strictly newer time_updated
      db.prepare(
        "INSERT INTO session (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_overlap_v1_newer", projectRoot, "Newer V1 title", null, base, base + 700);
      db.prepare(
        "INSERT INTO session_v2 (id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_overlap_v1_newer", projectRoot, "Older V2 title", null, base, base + 600);

      db.close();

      const discovered = discoverProjectCliSessions(projectRoot, {
        homeDir,
        harnesses: ["opencode"],
        persist: false,
      });
      assert.equal(discovered.length, 5, "Should deduplicate overlapping IDs across session and session_v2");
      const byId = new Map(discovered.map((d) => [d.harnessSessionId, d]));
      assert.equal(byId.get("ses_legacy_only")?.summary, "Legacy only session");
      assert.equal(byId.get("ses_v2_only")?.summary, "V2 only session");
      assert.equal(byId.get("ses_overlap_v2_newer")?.summary, "New V2 title");
      assert.equal(byId.get("ses_overlap_v2_newer")?.updatedAt, base + 500);
      assert.equal(byId.get("ses_overlap_tie")?.summary, "Tie V2 title");
      assert.equal(byId.get("ses_overlap_v1_newer")?.summary, "Newer V1 title");
      assert.equal(byId.get("ses_overlap_v1_newer")?.updatedAt, base + 700);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
