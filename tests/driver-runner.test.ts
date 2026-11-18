import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openProjectDb } from "../src/core/db.ts";
import {
  attachDriver,
  cancelDriverTurn,
  closeAllDriverSessions,
  getActiveDriver,
  parseDriverStreamLine,
  runDriverTurn,
  type DriverStreamEvent,
} from "../src/core/drivers.ts";

function makeTempDir(prefix = "asd-driver-runner-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("CR-03: runDriverTurn first run uses headless command, records session_id, deletes output.log, and second run uses resume", async () => {
  const root = makeTempDir();
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261101-120300-drv1";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
    });

    const calls: Array<{ cmd: string; args: string[]; env: any }> = [];
    const chunks: string[] = [];

    const firstRes = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Hello first turn",
      onOutput: (c) => chunks.push(c),
      commandRunner: {
        async run(cmd, args, opts) {
          calls.push({ cmd, args, env: opts.env });
          opts.onSpawn?.(42424);
          opts.onStdout(
            JSON.stringify({ session_id: "cc-sess-001", text: `secret ${["sk", "1234567890abcdefghijklmnop"].join("-")}` }) + "\n"
          );
          return { exitCode: 0, pid: 42424 };
        },
      },
    });

    assert.equal(firstRes.exitCode, 0);
    assert.equal(firstRes.harnessSessionId, "cc-sess-001");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "claude");
    assert.ok(!calls[0]!.args.includes("--resume"), "First run should not use --resume");
    assert.equal(calls[0]!.env.ASD_SESSION_ROLE, "driver");
    assert.equal(calls[0]!.env.ASD_MAIN_SESSION_ID, sessionId);
    assert.equal(calls[0]!.env.ASD_DRIVER_ID, firstRes.driverId);

    // Check output.log deleted and meta.json exists with status=done
    assert.ok(fs.existsSync(firstRes.metaPath));
    assert.equal(fs.existsSync(path.join(path.dirname(firstRes.metaPath), "output.log")), false);
    const meta = JSON.parse(fs.readFileSync(firstRes.metaPath, "utf8"));
    assert.equal(meta.status, "done");
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.harnessSessionId, "cc-sess-001");

    // Check active driver in DB updated
    const active = getActiveDriver(db, sessionId);
    assert.equal(active?.harness_session_id, "cc-sess-001");

    // Check secret masking in onOutput
    assert.ok(!chunks.join("").includes(["sk", "1234567890abcdefghijklmnop"].join("-")));

    // Second run: should use --resume cc-sess-001
    const secondRes = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Second turn follow up",
      commandRunner: {
        async run(cmd, args, opts) {
          calls.push({ cmd, args, env: opts.env });
          opts.onStdout(JSON.stringify({ session_id: "cc-sess-001" }) + "\n");
          return { exitCode: 0, pid: 42425 };
        },
      },
    });

    assert.equal(secondRes.exitCode, 0);
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.args.includes("--resume"), "Second run must use --resume");
    assert.ok(calls[1]!.args.includes("cc-sess-001"));

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-03: runDriverTurn injects briefing once when switching to a new driver and rejects concurrent execution with DRIVER_BUSY", async () => {
  const root = makeTempDir();
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261101-120301-drv2";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
      memo: "Briefing test session",
    });

    // Switch to codex driver so there is a previous driver
    attachDriver(db, {
      projectRoot: root,
      sessionId,
      harness: "codex",
      model: "gpt-5.4",
      source: "gui-prompt",
    });

    const receivedArgs: string[][] = [];

    // First run on new driver: auto briefing should be injected
    await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Continue work in codex",
      commandRunner: {
        async run(_cmd, args, opts) {
          receivedArgs.push(args);
          opts.onStdout(JSON.stringify({ thread_id: "codex-thread-99" }) + "\n");
          return { exitCode: 0, pid: 50001 };
        },
      },
    });

    assert.equal(receivedArgs.length, 1);
    const firstJoined = receivedArgs[0]!.join(" ");
    assert.ok(firstJoined.includes("# ASD Session Briefing"), "First turn of switched driver must include briefing");
    assert.ok(firstJoined.includes("Continue work in codex"));

    // Second run on same driver: briefing_injected is now 1, so briefing should NOT be injected
    await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Next prompt without briefing",
      commandRunner: {
        async run(_cmd, args) {
          receivedArgs.push(args);
          return { exitCode: 0, pid: 50002 };
        },
      },
    });

    assert.equal(receivedArgs.length, 2);
    const secondJoined = receivedArgs[1]!.join(" ");
    assert.ok(!secondJoined.includes("# ASD Session Briefing"), "Second turn must not re-inject briefing");
    assert.ok(secondJoined.includes("Next prompt without briefing"));

    // Concurrent execution on same driver -> DRIVER_BUSY
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });

    const runningPromise = runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Slow turn",
      commandRunner: {
        async run() {
          await slowGate;
          return { exitCode: 0, pid: 50003 };
        },
      },
    });

    await assert.rejects(
      () =>
        runDriverTurn({
          projectRoot: root,
          db,
          sessionId,
          prompt: "Concurrent turn",
          commandRunner: {
            async run() {
              return { exitCode: 0, pid: 50004 };
            },
          },
        }),
      /DRIVER_BUSY/
    );

    releaseSlow();
    await runningPromise;

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T2.2: runDriverTurn emits structured onEvent callbacks for thinking, tool_use, tool_result, and text across harnesses", async () => {
  const root = makeTempDir("asd-driver-events-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261103-184500-evnt";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
    });

    const events: DriverStreamEvent[] = [];
    const res = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Stream everything",
      streamJson: true,
      onEvent: (ev) => events.push(ev),
      commandRunner: {
        async run(_cmd, args, opts) {
          assert.ok(args.includes("stream-json"), "streamJson should switch claude output format to stream-json");
          opts.onStdout(
            JSON.stringify({
              type: "assistant",
              session_id: "cc-stream-1",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "Step 1: inspect files" },
                  { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
                ],
              },
            }) + "\n"
          );
          opts.onStdout(
            JSON.stringify({
              type: "user",
              message: {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "tu_1", content: "file1.ts\nfile2.ts" },
                ],
              },
            }) + "\n"
          );
          opts.onStdout(
            JSON.stringify({
              type: "result",
              session_id: "cc-stream-1",
              result: "Completed inspection.",
            }) + "\n"
          );
          return { exitCode: 0, pid: 60001 };
        },
      },
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.harnessSessionId, "cc-stream-1");
    assert.equal(events.length, 4);
    assert.equal(events[0]?.type, "thinking");
    assert.equal(events[0]?.thinking, "Step 1: inspect files");
    assert.equal(events[1]?.type, "tool_use");
    assert.equal(events[1]?.toolName, "Bash");
    assert.equal(events[2]?.type, "tool_result");
    assert.equal(events[2]?.toolOutput, "file1.ts\nfile2.ts");
    assert.equal(events[3]?.type, "text");
    assert.equal(events[3]?.text, "Completed inspection.");

    // Verify parseDriverStreamLine for Codex & OpenCode & Antigravity
    const codexEvents = parseDriverStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd_1", command: "npm test", aggregated_output: "PASS", exit_code: 0 },
      }),
      "codex"
    );
    assert.equal(codexEvents[0]?.type, "tool_result");
    assert.equal(codexEvents[0]?.toolOutput, "PASS");

    const ocEvents = parseDriverStreamLine(
      JSON.stringify({
        type: "tool",
        part: { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { path: "a.ts" }, output: "content" } },
      }),
      "opencode"
    );
    assert.equal(ocEvents.length, 2);
    assert.equal(ocEvents[0]?.type, "tool_use");
    assert.equal(ocEvents[1]?.type, "tool_result");

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("F16: runDriverTurn recovers full session_id when JSON line is split across stdout chunks", async () => {
  const root = makeTempDir("asd-driver-split-sid-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261105-090000-f16a";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
    });

    const fullUuid = "550e8400-e29b-41d4-a716-446655440000";
    const jsonLine = JSON.stringify({ type: "system", session_id: fullUuid, text: "hello" }) + "\n";
    // Split right in the middle of the UUID
    const splitIdx = jsonLine.indexOf("41d4");
    const chunk1 = jsonLine.slice(0, splitIdx);
    const chunk2 = jsonLine.slice(splitIdx);

    const firstRes = await runDriverTurn({
      projectRoot: root,
      homeDir: root,
      db,
      sessionId,
      prompt: "First turn with split chunks",
      commandRunner: {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(70001);
          opts.onStdout(chunk1);
          opts.onStdout(chunk2);
          return { exitCode: 0, pid: 70001 };
        },
      },
    });

    assert.equal(firstRes.exitCode, 0);
    assert.equal(firstRes.harnessSessionId, fullUuid);
    const active = getActiveDriver(db, sessionId);
    assert.equal(active?.harness_session_id, fullUuid);

    const resumeArgs: string[][] = [];
    await runDriverTurn({
      projectRoot: root,
      homeDir: root,
      db,
      sessionId,
      prompt: "Second turn resume check",
      commandRunner: {
        async run(_cmd, args) {
          resumeArgs.push(args);
          return { exitCode: 0, pid: 70002 };
        },
      },
    });

    assert.equal(resumeArgs.length, 1);
    assert.ok(resumeArgs[0]!.includes("--resume"));
    assert.ok(resumeArgs[0]!.includes(fullUuid));

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T2.1 (1): runDriverTurn ACP resident multi-turn reuse calls session/new once, reuses PID, invokes setSessionModel, and omits onOutput", async () => {
  const root = makeTempDir("asd-driver-acp-reuse-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261118-090001-acp1";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "model-alpha",
    });

    const mockPath = path.join(root, "mock-acp-resident.mjs");
    fs.writeFileSync(
      mockPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let newCount = 0;
let promptCount = 0;
const setModelCalls = [];

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    newCount += 1;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-drv-sess-1" } });
  } else if (msg.method === "session/set_model") {
    setModelCalls.push(msg.params?.modelId ?? null);
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    promptCount += 1;
    const sid = msg.params?.sessionId ?? "acp-drv-sess-1";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking-" + promptCount } }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "tool_call", toolCallId: "tc-" + promptCount, title: "Read", kind: "read", rawInput: { path: "a.ts" } }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc-" + promptCount, title: "Read", status: "completed", rawOutput: "ok" }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({ pid: process.pid, newCount, promptCount, setModelCalls })
          }
        }
      }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
      `.trim()
    );

    const rawOutputs1: string[] = [];
    const events1: DriverStreamEvent[] = [];
    const res1 = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Turn 1",
      acpCommandOverride: { command: process.execPath, args: [mockPath] },
      onOutput: (chunk) => rawOutputs1.push(chunk),
      onEvent: (ev) => events1.push(ev),
    });

    assert.equal(res1.exitCode, 0);
    assert.equal(res1.harnessSessionId, "acp-drv-sess-1");
    assert.equal(rawOutputs1.length, 0, "ACP path must NOT call onOutput");
    assert.ok(events1.some((e) => e.type === "status" && e.harnessSessionId === "acp-drv-sess-1"));
    assert.ok(events1.some((e) => e.type === "thinking" && e.thinking === "thinking-1"));
    assert.ok(events1.some((e) => e.type === "tool_use" && e.toolName === "Read"));
    assert.ok(events1.some((e) => e.type === "tool_result" && e.toolOutput === "ok"));

    const text1 = events1.find((e) => e.type === "text")?.text;
    assert.ok(text1);
    const info1 = JSON.parse(text1) as { pid: number; newCount: number; promptCount: number; setModelCalls: string[] };
    assert.equal(info1.newCount, 1);
    assert.equal(info1.promptCount, 1);
    assert.deepEqual(info1.setModelCalls, ["model-alpha"]);

    const meta1 = JSON.parse(fs.readFileSync(res1.metaPath, "utf8")) as {
      transport?: string;
      pid?: number;
      status?: string;
      harnessSessionId?: string;
    };
    assert.equal(meta1.transport, "acp");
    assert.equal(meta1.pid, info1.pid);
    assert.equal(meta1.status, "done");
    assert.equal(meta1.harnessSessionId, "acp-drv-sess-1");
    assert.equal(getActiveDriver(db, sessionId)?.harness_session_id, "acp-drv-sess-1");

    // Turn 2: same session & driver, changed model -> reuses SAME process & calls setSessionModel
    const rawOutputs2: string[] = [];
    const events2: DriverStreamEvent[] = [];
    const res2 = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Turn 2",
      model: "model-beta",
      acpCommandOverride: { command: process.execPath, args: [mockPath] },
      onOutput: (chunk) => rawOutputs2.push(chunk),
      onEvent: (ev) => events2.push(ev),
    });

    assert.equal(res2.exitCode, 0);
    assert.equal(res2.harnessSessionId, "acp-drv-sess-1");
    assert.equal(rawOutputs2.length, 0, "ACP path must NOT call onOutput on Turn 2");

    const text2 = events2.find((e) => e.type === "text")?.text;
    assert.ok(text2);
    const info2 = JSON.parse(text2) as { pid: number; newCount: number; promptCount: number; setModelCalls: string[] };
    assert.equal(info2.pid, info1.pid, "Turn 2 must reuse the same pooled PID");
    assert.equal(info2.newCount, 1, "session/new must be called only once across turns");
    assert.equal(info2.promptCount, 2);
    assert.deepEqual(info2.setModelCalls, ["model-alpha", "model-beta"]);

    db.close();
  } finally {
    await closeAllDriverSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T2.1 (2): runDriverTurn ACP interactive autoApprove:false delegates to onPermissionRequest and respawns when launchArgs change", async () => {
  const root = makeTempDir("asd-driver-acp-perm-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261118-090002-acp2";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "antigravity",
      mainModel: "gemini-4-carbon-high",
    });

    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const mockPath = path.join(binDir, "mock-acp-perm.mjs");
    fs.writeFileSync(
      mockPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let promptMsgId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-perm-sess-1" } });
  } else if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    promptMsgId = msg.id;
    send({
      jsonrpc: "2.0",
      id: 501,
      method: "session/request_permission",
      params: {
        sessionId: "acp-perm-sess-1",
        toolCall: { toolCallId: "tc-edit", kind: "edit", title: "Edit src/ok.ts", locations: [{ path: "src/ok.ts" }] },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject once", kind: "reject_once" }
        ]
      }
    });
  } else if (msg.id === 501 && !msg.method) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-perm-sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({
              pid: process.pid,
              argv: process.argv.slice(2),
              selected: msg.result?.outcome?.optionId ?? msg.result?.outcome?.outcome
            })
          }
        }
      }
    });
    send({ jsonrpc: "2.0", id: promptMsgId, result: { stopReason: "end_turn" } });
  }
});
      `.trim()
    );

    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(binDir, "agy.cmd"),
        `@echo off\r\n"${process.execPath}" "%~dp0%\\mock-acp-perm.mjs" %*\r\n`
      );
    } else {
      const agySh = path.join(binDir, "agy");
      fs.writeFileSync(
        agySh,
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/mock-acp-perm.mjs" "$@"\n`
      );
      fs.chmodSync(agySh, 0o755);
    }

    const pathEnv = `${binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
    const envOverride = { PATH: pathEnv, Path: pathEnv };

    // Turn 1: autoApprove: false -> probeAcpCapability returns ["acp"], calls onPermissionRequest
    const permRequests: string[] = [];
    const events1: DriverStreamEvent[] = [];
    const res1 = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Edit with interactive approval",
      autoApprove: false,
      env: envOverride,
      onPermissionRequest: async (params) => {
        permRequests.push(params.toolCall?.title ?? "");
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      },
      onEvent: (ev) => events1.push(ev),
    });

    assert.equal(res1.exitCode, 0);
    assert.deepEqual(permRequests, ["Edit src/ok.ts"]);
    const info1 = JSON.parse(events1.find((e) => e.type === "text")!.text!) as {
      pid: number;
      argv: string[];
      selected: string;
    };
    assert.deepEqual(info1.argv, ["acp"]);
    assert.equal(info1.selected, "allow_once");

    // Turn 2: toggle autoApprove: true -> launchArgs changes to ["acp", "--dangerously-skip-permissions"] -> must respawn!
    let permCallbackCount = 0;
    const events2: DriverStreamEvent[] = [];
    const res2 = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Edit with autoApprove true",
      autoApprove: true,
      env: envOverride,
      onPermissionRequest: async () => {
        permCallbackCount += 1;
        return { outcome: { outcome: "cancelled" } };
      },
      onEvent: (ev) => events2.push(ev),
    });

    assert.equal(res2.exitCode, 0);
    assert.equal(permCallbackCount, 0, "autoApprove: true should auto-select without calling onPermissionRequest");
    const info2 = JSON.parse(events2.find((e) => e.type === "text")!.text!) as {
      pid: number;
      argv: string[];
      selected: string;
    };
    assert.notEqual(info2.pid, info1.pid, "Toggling autoApprove on antigravity must respawn when launchArgs change");
    assert.deepEqual(info2.argv, ["acp", "--dangerously-skip-permissions"]);
    assert.equal(info2.selected, "allow_once");

    // Turn 3: autoApprove: true again -> reuses pid2
    const events3: DriverStreamEvent[] = [];
    const res3 = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Reuse second process",
      autoApprove: true,
      env: envOverride,
      onEvent: (ev) => events3.push(ev),
    });
    assert.equal(res3.exitCode, 0);
    const info3 = JSON.parse(events3.find((e) => e.type === "text")!.text!) as { pid: number };
    assert.equal(info3.pid, info2.pid);

    db.close();
  } finally {
    await closeAllDriverSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T2.1 (3): runDriverTurn ACP cooperative cancellation via cancelDriverTurn and AbortSignal sends session/cancel and preserves live pooled client", async () => {
  const root = makeTempDir("asd-driver-acp-cancel-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261118-090003-acp3";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-5-5",
    });

    const mockPath = path.join(root, "mock-acp-cancel.mjs");
    fs.writeFileSync(
      mockPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let pendingPromptId = null;
let cancelCount = 0;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-cancel-sess-1" } });
  } else if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const text = msg.params?.prompt?.[0]?.text ?? "";
    const sid = msg.params?.sessionId ?? "acp-cancel-sess-1";
    if (text.includes("normal")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify({ pid: process.pid, cancelCount }) }
          }
        }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    pendingPromptId = msg.id;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working:" + process.pid } }
      }
    });
  } else if (msg.method === "session/cancel") {
    cancelCount += 1;
    if (pendingPromptId !== null) {
      const idToResolve = pendingPromptId;
      pendingPromptId = null;
      send({ jsonrpc: "2.0", id: idToResolve, result: { stopReason: "cancelled" } });
    }
  }
});
      `.trim()
    );

    assert.equal(cancelDriverTurn(sessionId), false);

    // Sub-turn 1: cancel via cancelDriverTurn(sessionId)
    let resolveWorking1!: (pid: number) => void;
    const working1 = new Promise<number>((r) => {
      resolveWorking1 = r;
    });
    const turn1Promise = runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "wait for cancelDriverTurn",
      acpCommandOverride: { command: process.execPath, args: [mockPath] },
      onEvent: (ev) => {
        if (ev.type === "text" && ev.text?.startsWith("working:")) {
          resolveWorking1(Number(ev.text.split(":")[1]));
        }
      },
    });

    const pid1 = await working1;
    assert.equal(cancelDriverTurn(sessionId), true);
    const res1 = await turn1Promise;
    assert.notEqual(res1.exitCode, 0);
    assert.equal(res1.harnessSessionId, "acp-cancel-sess-1");
    const meta1 = JSON.parse(fs.readFileSync(res1.metaPath, "utf8")) as { status?: string };
    assert.equal(meta1.status, "failed");

    // Sub-turn 2: cancel via AbortSignal -> reuses SAME live process pid1
    const ac = new AbortController();
    let resolveWorking2!: (pid: number) => void;
    const working2 = new Promise<number>((r) => {
      resolveWorking2 = r;
    });
    const turn2Promise = runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "wait for AbortSignal",
      signal: ac.signal,
      acpCommandOverride: { command: process.execPath, args: [mockPath] },
      onEvent: (ev) => {
        if (ev.type === "text" && ev.text?.startsWith("working:")) {
          resolveWorking2(Number(ev.text.split(":")[1]));
        }
      },
    });

    const pid2 = await working2;
    assert.equal(pid2, pid1, "Cooperative cancel via cancelDriverTurn must keep pooled process alive");
    ac.abort();
    const res2 = await turn2Promise;
    assert.notEqual(res2.exitCode, 0);

    // Sub-turn 3: normal completion -> still reuses SAME live process pid1 and saw 2 cancels
    const events3: DriverStreamEvent[] = [];
    const res3 = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "normal completion",
      acpCommandOverride: { command: process.execPath, args: [mockPath] },
      onEvent: (ev) => events3.push(ev),
    });
    assert.equal(res3.exitCode, 0);
    const info3 = JSON.parse(events3.find((e) => e.type === "text")!.text!) as {
      pid: number;
      cancelCount: number;
    };
    assert.equal(info3.pid, pid1, "Cooperative cancel via AbortSignal must keep pooled process alive");
    assert.equal(info3.cancelCount, 2);

    db.close();
  } finally {
    await closeAllDriverSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T2.1 (4): runDriverTurn transport:auto falls back to CLI when ACP unsupported or handshake fails, and transport:acp throws ACP_UNAVAILABLE", async () => {
  const root = makeTempDir("asd-driver-acp-fallback-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261118-090004-acp4";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-5-5",
    });

    const emptyBinDir = path.join(root, "empty-bin");
    fs.mkdirSync(emptyBinDir, { recursive: true });
    const emptyEnv = { PATH: emptyBinDir, Path: emptyBinDir };

    // Case A: transport: "acp" when ACP binary is unavailable -> throws ACP_UNAVAILABLE
    await assert.rejects(
      () =>
        runDriverTurn({
          projectRoot: root,
          db,
          sessionId,
          prompt: "Must fail ACP unavailable",
          transport: "acp",
          env: emptyEnv,
        }),
      /ACP_UNAVAILABLE/
    );

    // Case B: transport: "auto" when ACP probe supported === false -> falls back to CLI
    let cliCalls = 0;
    const resUnsupported = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Fallback on unsupported",
      transport: "auto",
      env: emptyEnv,
      commandRunner: {
        async run(_cmd, _args, opts) {
          cliCalls += 1;
          opts.onStdout(JSON.stringify({ session_id: "cli-fallback-1", text: "ok" }) + "\n");
          return { exitCode: 0, pid: 81001 };
        },
      },
    });
    assert.equal(cliCalls, 1);
    assert.equal(resUnsupported.exitCode, 0);
    assert.equal(resUnsupported.harnessSessionId, "cli-fallback-1");

    // Case C: transport: "auto" when ACP handshake fails -> cleans up and falls back to CLI
    const badAcpPath = path.join(root, "bad-acp-handshake.mjs");
    fs.writeFileSync(badAcpPath, `process.exit(1);\n`);

    const resHandshakeFail = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Fallback on handshake error",
      transport: "auto",
      acpCommandOverride: { command: process.execPath, args: [badAcpPath] },
      commandRunner: {
        async run(_cmd, _args, opts) {
          cliCalls += 1;
          opts.onStdout(JSON.stringify({ session_id: "cli-fallback-1", text: "ok2" }) + "\n");
          return { exitCode: 0, pid: 81002 };
        },
      },
    });
    assert.equal(cliCalls, 2);
    assert.equal(resHandshakeFail.exitCode, 0);

    db.close();
  } finally {
    await closeAllDriverSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
