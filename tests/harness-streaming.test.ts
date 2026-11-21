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
import { openProjectDb } from "../src/core/db.ts";
import {
  abortOpenCodeServerSession,
  createStreamParser,
  parseDriverStreamLine,
  resolveOpenCodeServerEndpoints,
  runDriverTurn,
  runOpenCodeSseWithCliFallback,
} from "../src/core/drivers.ts";
import {
  buildOpenCodeCapabilityProfile,
  resetOpenCodeVersionCache,
} from "../src/core/opencode-profile.ts";
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

describe("T4.2: OpenCode V2 SSE Framing, Endpoints & Streaming CLI Fallback", () => {
  it("parses V2 BusEvent SSE frames (message.part.updated, message.part.delta, GlobalEvent shell tool) while ignoring SSE heartbeats", () => {
    const parser = createStreamParser({ harness: "opencode" });
    const v2Sse = [
      ": keepalive\n",
      "id: evt-1\n",
      "event: server.connected\n",
      'data: {"type":"server.connected","properties":{}}\n\n',
      "event: message.part.delta\n",
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_v2_sse","field":"reasoning","delta":"inspecting code"}}\n\n',
      "event: message.part.delta\n",
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_v2_sse","field":"text","delta":"Hello V2"}}\n\n',
      "event: message.part.updated\n",
      'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"part":{"type":"tool","tool":"shell","callID":"call_v2_1","sessionID":"ses_v2_sse","state":{"status":"completed","input":{"command":"git status"},"output":"clean"}}}}}\n\n',
    ].join("");

    const events = parser.pushChunk(v2Sse);
    assert.equal(events.length, 4);

    assert.equal(events[0]?.type, "thinking");
    assert.equal(events[0]?.thinking, "inspecting code");
    assert.equal(events[0]?.harnessSessionId, "ses_v2_sse");

    assert.equal(events[1]?.type, "text");
    assert.equal(events[1]?.text, "Hello V2");
    assert.equal(events[1]?.harnessSessionId, "ses_v2_sse");

    assert.equal(events[2]?.type, "tool_use");
    assert.equal(events[2]?.toolName, "shell");
    assert.equal(events[2]?.toolId, "call_v2_1");
    assert.equal(events[2]?.harnessSessionId, "ses_v2_sse");

    assert.equal(events[3]?.type, "tool_result");
    assert.equal(events[3]?.toolName, "shell");
    assert.equal(events[3]?.toolOutput, "clean");
    assert.equal(events[3]?.harnessSessionId, "ses_v2_sse");
  });

  it("resolveOpenCodeServerEndpoints and abortOpenCodeServerSession route V2 to /api/event + /api/session/{id}/interrupt and V1 to /event + /session/{id}/abort", async () => {
    resetOpenCodeVersionCache();
    try {
      const v2Endpoints = resolveOpenCodeServerEndpoints("http://127.0.0.1:4096/", {
        env: { ASD_OPENCODE_PROFILE: "v2" },
      });
      assert.equal(v2Endpoints.eventPath, "/api/event");
      assert.equal(v2Endpoints.eventUrl, "http://127.0.0.1:4096/api/event");
      assert.equal(
        v2Endpoints.buildAbortUrl("ses_v2_1"),
        "http://127.0.0.1:4096/api/session/ses_v2_1/interrupt"
      );

      const v1Endpoints = resolveOpenCodeServerEndpoints("http://127.0.0.1:4096/", {
        env: { ASD_OPENCODE_PROFILE: "v1" },
      });
      assert.equal(v1Endpoints.eventPath, "/event");
      assert.equal(v1Endpoints.eventUrl, "http://127.0.0.1:4096/event");
      assert.equal(
        v1Endpoints.buildAbortUrl("ses_v1_1"),
        "http://127.0.0.1:4096/session/ses_v1_1/abort"
      );

      const calls: Array<{ url: string; method?: string }> = [];
      const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const v2Ctrl = new AbortController();
      const v2Ok = await abortOpenCodeServerSession({
        serverUrl: "http://127.0.0.1:4096",
        sessionId: "ses_v2_1",
        env: { ASD_OPENCODE_PROFILE: "v2" },
        abortController: v2Ctrl,
        fetchImpl: mockFetch,
      });
      assert.equal(v2Ok, true);
      assert.equal(v2Ctrl.signal.aborted, true);

      const v1Profile = buildOpenCodeCapabilityProfile({
        rawOutput: "1.19.4",
        version: "1.19.4",
        major: 1,
        pluginApi: "v1",
        source: "cli-probe",
      });
      const v1Ok = await abortOpenCodeServerSession({
        serverUrl: "http://127.0.0.1:4096",
        sessionId: "ses_v1_1",
        profile: v1Profile,
        fetchImpl: mockFetch,
      });
      assert.equal(v1Ok, true);

      assert.deepEqual(calls, [
        { url: "http://127.0.0.1:4096/api/session/ses_v2_1/interrupt", method: "POST" },
        { url: "http://127.0.0.1:4096/session/ses_v1_1/abort", method: "POST" },
      ]);
    } finally {
      resetOpenCodeVersionCache();
    }
  });

  it("runOpenCodeSseWithCliFallback streams V2 /api/event on success and falls back cleanly on server failure", async () => {
    const encoder = new TextEncoder();
    const seenUrls: string[] = [];

    const sseSuccessFetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message.part.updated\ndata: {"type":"message.part.updated","properties":{"part":{"type":"text","text":"streamed via /api/event"}}}\n\n'
            )
          );
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    let fallbackCalled = false;
    const okRes = await runOpenCodeSseWithCliFallback({
      serverUrl: "http://127.0.0.1:4096",
      env: { ASD_OPENCODE_PROFILE: "v2" },
      fetchImpl: sseSuccessFetch,
      fallbackToCli: async () => {
        fallbackCalled = true;
        return "cli";
      },
    });
    assert.equal(okRes.mode, "daemon-sse");
    assert.equal(fallbackCalled, false);
    assert.deepEqual(seenUrls, ["http://127.0.0.1:4096/api/event"]);
    if (okRes.mode === "daemon-sse") {
      assert.equal(okRes.result.events[0]?.text, "streamed via /api/event");
    }

    const sseFailFetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const failRes = await runOpenCodeSseWithCliFallback({
      serverUrl: "http://127.0.0.1:4096",
      env: { ASD_OPENCODE_PROFILE: "v2" },
      fetchImpl: sseFailFetch,
      fallbackToCli: async ({ profile, sseResult }) => ({
        profile: profile.effectiveProfile,
        flags: profile.headlessRunFlags,
        status: sseResult.status,
      }),
    });
    assert.equal(failRes.mode, "cli-fallback");
    if (failRes.mode === "cli-fallback") {
      assert.deepEqual(failRes.result, {
        profile: "v2",
        flags: ["--auto"],
        status: 404,
      });
    }
  });

  it("runDriverTurn falls back from failed OpenCode server SSE to streaming CLI using V2 --auto (omitting --pure) and V1 --pure", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asd-oc-driver-fallback-"));
    try {
      const db = openProjectDb(tmpRoot, tmpRoot);
      const sessionId = "asd-20261121-220000-ocv2";
      db.createOrGetSession({
        sessionId,
        projectRoot: tmpRoot,
        mainHarness: "opencode",
        mainModel: "z-ai/glm-5.3-flash",
      });

      const requestedUrls: string[] = [];
      const cliInvocations: Array<{ cmd: string; args: string[] }> = [];
      const failingFetch = (async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return new Response("Unavailable", { status: 503 });
      }) as typeof fetch;

      // V2 fallback: hits /api/event, fails over to CLI with --auto and WITHOUT --pure
      const v2Events: string[] = [];
      const v2Turn = await runDriverTurn({
        projectRoot: tmpRoot,
        db,
        sessionId,
        prompt: "Run V2 fallback",
        openCodeServerUrl: "http://127.0.0.1:4096",
        fetchImpl: failingFetch,
        env: { ASD_OPENCODE_PROFILE: "v2" },
        onEvent: (ev) => {
          if (ev.type === "text" && ev.text) v2Events.push(ev.text);
        },
        commandRunner: {
          async run(cmd, args, opts) {
            cliInvocations.push({ cmd, args });
            opts.onStdout(
              JSON.stringify({
                part: { type: "text", text: "v2 cli fallback ok", sessionID: "ses_oc_v2_cli" },
              }) + "\n"
            );
            return { exitCode: 0, pid: 71001 };
          },
        },
      });

      assert.equal(v2Turn.exitCode, 0);
      assert.equal(v2Turn.harnessSessionId, "ses_oc_v2_cli");
      assert.deepEqual(requestedUrls, ["http://127.0.0.1:4096/api/event"]);
      assert.equal(cliInvocations.length, 1);
      assert.equal(cliInvocations[0]?.cmd, "opencode");
      assert.ok(cliInvocations[0]?.args.includes("--auto"), "V2 CLI fallback must include --auto");
      assert.ok(!cliInvocations[0]?.args.includes("--pure"), "V2 CLI fallback must omit --pure");
      assert.deepEqual(v2Events, ["v2 cli fallback ok"]);

      // V1 fallback: hits /event, fails over to CLI with --pure
      const v1Turn = await runDriverTurn({
        projectRoot: tmpRoot,
        db,
        sessionId,
        prompt: "Run V1 fallback",
        openCodeServerUrl: "http://127.0.0.1:4096",
        fetchImpl: failingFetch,
        env: { ASD_OPENCODE_PROFILE: "v1" },
        commandRunner: {
          async run(cmd, args, opts) {
            cliInvocations.push({ cmd, args });
            opts.onStdout(
              JSON.stringify({
                part: { type: "text", text: "v1 cli fallback ok", sessionID: "ses_oc_v2_cli" },
              }) + "\n"
            );
            return { exitCode: 0, pid: 71002 };
          },
        },
      });

      assert.equal(v1Turn.exitCode, 0);
      assert.deepEqual(requestedUrls, [
        "http://127.0.0.1:4096/api/event",
        "http://127.0.0.1:4096/event",
      ]);
      assert.equal(cliInvocations.length, 2);
      assert.ok(cliInvocations[1]?.args.includes("--pure"), "V1 CLI fallback must include --pure");
      assert.ok(!cliInvocations[1]?.args.includes("--auto"), "V1 CLI fallback must not include --auto");

      db.close();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
