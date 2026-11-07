import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  abortOpencodeSession,
  shutdownOpencodeDaemon,
} from "../src/adapters/opencode.ts";
import {
  createStreamParser,
  parseDriverStreamLine,
} from "../src/core/drivers.ts";
import {
  buildSpawnSpec,
} from "../src/core/session-tracker.ts";
import { readHarnessTranscript } from "../src/core/transcripts.ts";

describe("T3.1: Stateful Stream Parser (Risk 2)", () => {
  it("buffers arbitrary chunk boundaries and emits parsed events correctly", () => {
    const parser = createStreamParser({ harness: "claude-code" });

    const ev1 = parser.pushChunk('{"type":"content_block_delta","delta":{"type":"text_');
    assert.deepEqual(ev1, []);

    const ev2 = parser.pushChunk('delta","text":"hello world"}}\n');
    assert.equal(ev2.length, 1);
    assert.equal(ev2[0]?.type, "text");
    assert.equal(ev2[0]?.text, "hello world");

    const ev3 = parser.flush();
    assert.deepEqual(ev3, []);
  });

  it("parses multi-line SSE format (opencode serve)", () => {
    const parser = createStreamParser({ harness: "opencode" });
    const ssePayload = [
      "event: message\n",
      'data: {"part":{"type":"text","text":"response from opencode"}}\n',
      "\n",
    ].join("");

    const events = parser.pushChunk(ssePayload);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "text");
    assert.equal(events[0]?.text, "response from opencode");
  });

  it("assembles content_block_start + input_json_delta + content_block_stop into single tool_use event", () => {
    const parser = createStreamParser({ harness: "claude-code" });

    const ev1 = parser.pushChunk(
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_abc123",
          name: "write_file",
          input: {},
        },
      }) + "\n"
    );
    assert.deepEqual(ev1, []);

    const ev2 = parser.pushChunk(
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"path":"src/',
        },
      }) + "\n"
    );
    assert.deepEqual(ev2, []);

    const ev3 = parser.pushChunk(
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: 'index.ts","content":"export {}"}',
        },
      }) + "\n"
    );
    assert.deepEqual(ev3, []);

    const ev4 = parser.pushChunk(
      JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }) + "\n"
    );
    assert.equal(ev4.length, 1);
    assert.equal(ev4[0]?.type, "tool_use");
    assert.equal(ev4[0]?.toolName, "write_file");
    assert.equal(ev4[0]?.toolId, "call_abc123");
    assert.equal(ev4[0]?.toolInput, '{"path":"src/index.ts","content":"export {}"}');
  });

  it("suppresses Cursor duplicate assistant text when repeated in type:result", () => {
    const parser = createStreamParser({ harness: "cursor" });

    const ev1 = parser.pushChunk(
      JSON.stringify({
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "I finished updating the configuration.",
        },
      }) + "\n"
    );
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0]?.type, "text");
    assert.equal(ev1[0]?.text, "I finished updating the configuration.");

    const ev2 = parser.pushChunk(
      JSON.stringify({
        type: "result",
        result: "I finished updating the configuration.",
        session_id: "cur_sess_999",
      }) + "\n"
    );
    assert.equal(ev2.length, 1);
    assert.equal(ev2[0]?.type, "status");
    assert.equal(ev2[0]?.harnessSessionId, "cur_sess_999");
  });

  it("preserves 100% backward compatibility for parseDriverStreamLine", () => {
    const raw = JSON.stringify({
      type: "thinking",
      subtype: "delta",
      text: "analyzing requirements...",
    });
    const events = parseDriverStreamLine(raw, "cursor");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "thinking");
    assert.equal(events[0]?.thinking, "analyzing requirements...");
  });
});

describe("T3.1: SpawnCommandSpec & Stdin Handling (Risks 1, 3, HC-2)", () => {
  it("offloads long prompt (>1500 chars) to stdinPayload and includes --dangerously-skip-permissions for claude-code", () => {
    const longPrompt = "A".repeat(1600);
    const spec = buildSpawnSpec({
      harness: "claude-code",
      prompt: longPrompt,
      model: "claude-3-7-sonnet",
    });

    assert.equal(spec.command, "claude");
    assert.equal(spec.stdinPayload, longPrompt);
    assert.equal(spec.closeStdinOnSpawn, true);
    assert.ok(spec.args.includes("--dangerously-skip-permissions"));
    assert.ok(spec.args.includes("-p"));
    assert.ok(!spec.args.includes(longPrompt));
  });

  it("keeps short prompt in args for claude-code", () => {
    const shortPrompt = "Short prompt under 1500 chars";
    const spec = buildSpawnSpec({
      harness: "claude-code",
      prompt: shortPrompt,
    });

    assert.equal(spec.command, "claude");
    assert.equal(spec.stdinPayload, undefined);
    assert.ok(spec.args.includes(shortPrompt));
    assert.ok(spec.args.includes("--dangerously-skip-permissions"));
  });

  it("enforces closeStdinOnSpawn: true for codex", () => {
    const spec = buildSpawnSpec({
      harness: "codex",
      prompt: "test task",
      model: "o3-mini",
    });

    assert.equal(spec.command, "codex");
    assert.equal(spec.closeStdinOnSpawn, true);
  });
});

describe("T3.1: Opencode Daemon Lifecycle & Transcripts Busy Retry (Risk 4)", () => {
  it("abortOpencodeSession aborts controller without killing pid in daemon-sse mode", () => {
    const controller = new AbortController();
    assert.equal(controller.signal.aborted, false);

    abortOpencodeSession({
      mode: "daemon-sse",
      isSharedDaemon: true,
      abortController: controller,
      pid: 999999,
    });

    assert.equal(controller.signal.aborted, true);
  });

  it("shutdownOpencodeDaemon only kills process when ownedByAsd is true and activeSubagents <= 0", () => {
    const res1 = shutdownOpencodeDaemon({
      pid: 999999,
      ownedByAsd: false,
      activeSubagents: 0,
    });
    assert.equal(res1, false);

    const res2 = shutdownOpencodeDaemon({
      pid: 999999,
      ownedByAsd: true,
      activeSubagents: 2,
    });
    assert.equal(res2, false);

    const res3 = shutdownOpencodeDaemon({
      pid: 0,
      ownedByAsd: true,
      activeSubagents: 0,
    });
    assert.equal(res3, false);
  });

  it("readOpencodeDbMessages executes with PRAGMA busy_timeout = 3000 on sqlite db", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-oc-test-"));
    try {
      const dbPath = path.join(tmpDir, "opencode.db");
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
        INSERT INTO message VALUES ('msg_1', 'oc_sess_1', '{"role":"assistant"}');
        INSERT INTO part VALUES ('part_1', 'msg_1', 'oc_sess_1', '{"type":"text","text":"hello test"}');
      `);
      db.close();

      const result = readHarnessTranscript("opencode", "oc_sess_1", {
        transcriptPath: dbPath,
      });
      assert.equal(result.found, true);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]?.text, "hello test");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
