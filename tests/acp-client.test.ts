/**
 * ASD ACP Client & Security Gate Tests (tests/acp-client.test.ts)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
  AcpStdioClient,
  CLAUDE_ACP_INSTALL_HINT,
  CODEX_ACP_INSTALL_HINT,
  evaluateAcpPermissionRequest,
  executeAcpSubagentTurn,
  probeAcpCapability,
  resolveAcpLaunchCommand,
  resolveBestAcpModelId,
} from "../src/core/acp-client.ts";
import type { AcpNormalizedEvent } from "../src/core/acp-types.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("ACP Capability Probing & Launch Resolution", () => {
  test("probeAcpCapability detects native ACP vs missing/installed bridges", () => {
    const binDir = makeTempDir("asd-acp-bins-");
    const ext = process.platform === "win32" ? ".cmd" : "";
    try {
      fs.writeFileSync(path.join(binDir, `opencode${ext}`), "echo ok", { mode: 0o755 });
      fs.writeFileSync(path.join(binDir, `agy${ext}`), "echo ok", { mode: 0o755 });
      fs.writeFileSync(
        path.join(binDir, process.platform === "win32" ? "cursor-agent.ps1" : "cursor-agent"),
        "echo ok",
        { mode: 0o755 }
      );

      const mockEnv = { PATH: binDir, Path: binDir };

      const oc = probeAcpCapability("opencode", mockEnv);
      assert.equal(oc.supported, true);
      assert.equal(oc.mode, "native");
      assert.deepEqual(oc.args, ["acp", "--pure"]);

      const ag = probeAcpCapability("antigravity", mockEnv);
      assert.equal(ag.supported, true);
      assert.equal(ag.mode, "native");
      assert.deepEqual(ag.args, ["acp", "--dangerously-skip-permissions"]);

      const agInteractive = probeAcpCapability("antigravity", mockEnv, {
        interactivePermissions: true,
      });
      assert.equal(agInteractive.supported, true);
      assert.deepEqual(agInteractive.args, ["acp"]);

      const agNonInteractive = probeAcpCapability("antigravity", mockEnv, {
        interactivePermissions: false,
      });
      assert.deepEqual(agNonInteractive.args, ["acp", "--dangerously-skip-permissions"]);

      const cr = probeAcpCapability("cursor", mockEnv);
      assert.equal(cr.supported, true);
      assert.equal(cr.mode, "native");

      const ccMissing = probeAcpCapability("claude-code", mockEnv);
      assert.equal(ccMissing.supported, false);
      assert.equal(ccMissing.mode, "missing-bridge");
      assert.equal(ccMissing.installHint, CLAUDE_ACP_INSTALL_HINT);

      const cxMissing = probeAcpCapability("codex", mockEnv);
      assert.equal(cxMissing.supported, false);
      assert.equal(cxMissing.mode, "missing-bridge");
      assert.equal(cxMissing.installHint, CODEX_ACP_INSTALL_HINT);

      fs.writeFileSync(path.join(binDir, `claude-agent-acp${ext}`), "echo ok", { mode: 0o755 });
      fs.writeFileSync(path.join(binDir, `codex-acp${ext}`), "echo ok", { mode: 0o755 });

      const ccReady = probeAcpCapability("claude-code", mockEnv);
      assert.equal(ccReady.supported, true);
      assert.equal(ccReady.mode, "bridge");

      const cxReady = probeAcpCapability("codex", mockEnv);
      assert.equal(cxReady.supported, true);
      assert.equal(cxReady.mode, "bridge");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("resolveAcpLaunchCommand wraps .ps1 scripts safely with powershell -File on win32", () => {
    const tmpDir = makeTempDir("asd-acp-ps1-");
    try {
      const ps1Path = path.join(tmpDir, "cursor-agent.ps1");
      fs.writeFileSync(ps1Path, "Write-Output 'hi'");
      const resolved = resolveAcpLaunchCommand(
        "cursor-agent",
        ["acp"],
        { PATH: tmpDir, Path: tmpDir },
        "win32"
      );
      assert.equal(resolved.shell, false);
      assert.ok(resolved.args.includes("-File"));
      assert.ok(resolved.args.includes(ps1Path));
      assert.equal(resolved.args.at(-1), "acp");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolveBestAcpModelId maps routing.jsonc model names onto OpenCode, Antigravity, and Cursor ACP catalogs", () => {
    // 1. OpenCode ACP (configOptions only, provider-prefixed IDs)
    const ocCatalog = {
      configOptions: [
        {
          id: "model",
          category: "model",
          options: [
            { value: "nvidia/z-ai/glm-5.3-flash" },
            { value: "nvidia/deepseek-ai/deepseek-v4.1-flash" },
          ],
        },
      ],
    };
    assert.equal(
      resolveBestAcpModelId("z-ai/glm-5.3-flash", ocCatalog).setModelId,
      "nvidia/z-ai/glm-5.3-flash"
    );
    assert.equal(
      resolveBestAcpModelId("deepseek-ai/deepseek-v4.1-flash", ocCatalog).configValue,
      "nvidia/deepseek-ai/deepseek-v4.1-flash"
    );

    // 2. Antigravity ACP (tier shorthands + effort-suffixed availableModels)
    const agCatalog = {
      availableModels: [
        { modelId: "gemini-4-carbon-high" },
        { modelId: "gemini-4-carbon-medium" },
        { modelId: "gemini-3.8-flash-medium" },
        { modelId: "gemini-3.8-flash-low" },
      ],
      configOptions: [
        {
          id: "model",
          category: "model",
          options: [{ value: "gemini-4-carbon" }, { value: "gemini-3.8-flash" }],
        },
      ],
    };
    assert.equal(
      resolveBestAcpModelId("flash_lite", agCatalog).setModelId,
      "gemini-3.8-flash-low"
    );
    assert.equal(
      resolveBestAcpModelId("flash", agCatalog).setModelId,
      "gemini-3.8-flash-medium"
    );
    assert.equal(
      resolveBestAcpModelId("pro", agCatalog).setModelId,
      "gemini-4-carbon-high"
    );
    assert.equal(
      resolveBestAcpModelId("gemini-3.8-flash", agCatalog).setModelId,
      "gemini-3.8-flash-medium"
    );

    // 3. Cursor ACP (bracket-parameterized modelIds & 'p'-escaped version slugs)
    const crCatalog = {
      availableModels: [
        { modelId: "default[]" },
        { modelId: "claude-opus-5-5[context=300k,effort=medium,fast=false]" },
        { modelId: "claude-sonnet-5-5[context=300k,reasoning_effort=high]" },
        { modelId: "glm-5p3-flash[reasoning=high]" },
        { modelId: "deepseek-v41-flash-1017[reasoning_effort=high]" },
      ],
    };
    assert.equal(
      resolveBestAcpModelId("claude-sonnet-5-5-medium", crCatalog).setModelId,
      "claude-sonnet-5-5[context=300k,reasoning_effort=high]"
    );
    assert.equal(
      resolveBestAcpModelId("z-ai/glm-5.3-flash", crCatalog).setModelId,
      "glm-5p3-flash[reasoning=high]"
    );
    assert.equal(
      resolveBestAcpModelId("deepseek-ai/deepseek-v4.1-flash", crCatalog).setModelId,
      "deepseek-v41-flash-1017[reasoning_effort=high]"
    );
  });
});

describe("ACP Permission Gate (session/request_permission)", () => {
  const stdOptions = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ];

  test("allows edits inside allowedFiles and rejects edits outside allowedFiles or on protected paths", () => {
    const cwd = makeTempDir("asd-acp-perm-");
    try {
      const allowRes = evaluateAcpPermissionRequest(
        {
          sessionId: "ses_1",
          toolCall: {
            kind: "edit",
            title: "Edit src/allowed.ts",
            locations: [{ path: path.join(cwd, "src", "allowed.ts") }],
          },
          options: stdOptions,
        },
        {
          harness: "opencode",
          role: "worker",
          cwd,
          allowedFiles: ["src/allowed.ts"],
        }
      );
      assert.equal(allowRes.allowed, true);
      assert.deepEqual(allowRes.result, {
        outcome: { outcome: "selected", optionId: "allow_once" },
      });

      const denyBoundary = evaluateAcpPermissionRequest(
        {
          sessionId: "ses_1",
          toolCall: {
            kind: "edit",
            title: "Edit src/forbidden.ts",
            locations: [{ path: path.join(cwd, "src", "forbidden.ts") }],
          },
          options: stdOptions,
        },
        {
          harness: "opencode",
          role: "worker",
          cwd,
          allowedFiles: ["src/allowed.ts"],
        }
      );
      assert.equal(denyBoundary.allowed, false);
      assert.deepEqual(denyBoundary.result, {
        outcome: { outcome: "selected", optionId: "reject_once" },
      });

      const denyProtected = evaluateAcpPermissionRequest(
        {
          sessionId: "ses_1",
          toolCall: {
            kind: "edit",
            title: "Edit .env",
            locations: [{ path: path.join(cwd, ".env") }],
          },
          options: stdOptions,
        },
        {
          harness: "opencode",
          role: "worker",
          cwd,
          allowedFiles: ["**/*"],
        }
      );
      assert.equal(denyProtected.allowed, false);

      const denyScout = evaluateAcpPermissionRequest(
        {
          sessionId: "ses_1",
          toolCall: {
            kind: "edit",
            title: "Edit src/allowed.ts",
            locations: [{ path: path.join(cwd, "src", "allowed.ts") }],
          },
          options: stdOptions,
        },
        {
          harness: "opencode",
          role: "scout",
          cwd,
          allowedFiles: ["src/allowed.ts"],
        }
      );
      assert.equal(denyScout.allowed, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("ACP Subprocess Turn Execution (v1 + v2 Draft Compatibility)", () => {
  test("executes ACP v1 turn with streaming chunks, permission handshake, and session/load resume", async () => {
    const dir = makeTempDir("asd-acp-v1-");
    const mockServerPath = path.join(dir, "mock-acp-v1.mjs");
    const logPath = path.join(dir, "output.log");

    fs.writeFileSync(
      mockServerPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let loadedFlag = false;

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-ses-v1-100" } });
  } else if (msg.method === "session/load") {
    loadedFlag = true;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
  } else if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning edit..." } }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: sid,
        toolCall: { kind: "edit", title: "Write src/ok.ts", locations: [{ path: "src/ok.ts" }] },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" }
        ]
      }
    });
    rl.once("line", (permLine) => {
      const permResp = JSON.parse(permLine);
      const chosen = permResp.result?.outcome?.optionId ?? "none";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: (loadedFlag ? "Resumed:" : "Fresh:") + chosen }
          }
        }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
  }
});
      `.trim()
    );

    try {
      let detectedSid = "";
      const res1 = await executeAcpSubagentTurn({
        harness: "opencode",
        role: "worker",
        model: "glm-5",
        prompt: "Implement feature",
        cwd: dir,
        allowedFiles: ["src/ok.ts"],
        logPath,
        commandOverride: { command: process.execPath, args: [mockServerPath] },
        onSessionIdDetected: (sid) => {
          detectedSid = sid;
        },
      });

      assert.equal(res1.status, "done");
      assert.equal(res1.exitCode, 0);
      assert.equal(res1.sessionId, "acp-ses-v1-100");
      assert.equal(detectedSid, "acp-ses-v1-100");
      assert.equal(res1.assistantText, "Fresh:allow_once");

      const logContent = fs.readFileSync(logPath, "utf8");
      assert.ok(logContent.includes("[thinking] Planning edit..."));
      assert.ok(logContent.includes("[acp_permission:allowed]"));

      const res2 = await executeAcpSubagentTurn({
        harness: "opencode",
        role: "worker",
        prompt: "Continue feature",
        cwd: dir,
        allowedFiles: ["src/ok.ts"],
        logPath,
        resumeSessionId: "acp-ses-v1-100",
        commandOverride: { command: process.execPath, args: [mockServerPath] },
      });
      assert.equal(res2.status, "done");
      assert.equal(res2.assistantText, "Resumed:allow_once");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("supports ACP v2 draft compatibility (early ACK + async idle session/update) and idle timeout cancellation", async () => {
    const dir = makeTempDir("asd-acp-v2-");
    const mockV2Path = path.join(dir, "mock-acp-v2.mjs");
    const mockStallPath = path.join(dir, "mock-acp-stall.mjs");
    const logPath = path.join(dir, "output.log");

    fs.writeFileSync(
      mockV2Path,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 2, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-ses-v2-200" } });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: msg.id, result: { accepted: true, state: "working" } });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "acp-ses-v2-200", update: { type: "message_chunk", delta: "Hello from v2!" } }
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "acp-ses-v2-200", state: "idle", stopReason: "end_turn" }
        });
      }, 40);
    }, 40);
  }
});
      `.trim()
    );

    fs.writeFileSync(
      mockStallPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-stall-999" } });
  } else if (msg.method === "session/prompt") {
    // Intentionally stall forever
  }
});
      `.trim()
    );

    try {
      const v2Res = await executeAcpSubagentTurn({
        harness: "antigravity",
        role: "worker",
        prompt: "Test v2",
        cwd: dir,
        allowedFiles: [],
        logPath,
        commandOverride: { command: process.execPath, args: [mockV2Path] },
      });

      assert.equal(v2Res.status, "done");
      assert.equal(v2Res.protocolVersion, 2);
      assert.equal(v2Res.assistantText, "Hello from v2!");
      assert.equal(v2Res.stopReason, "end_turn");

      const stallRes = await executeAcpSubagentTurn({
        harness: "antigravity",
        role: "worker",
        prompt: "Stall test",
        cwd: dir,
        allowedFiles: [],
        logPath,
        idleTimeoutMs: 200,
        commandOverride: { command: process.execPath, args: [mockStallPath] },
      });

      assert.equal(stallRes.status, "failed");
      assert.equal(stallRes.timedOut, true);
      assert.equal(stallRes.timeoutReason, "idle");
      assert.equal(stallRes.sessionId, "acp-stall-999");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AcpStdioClient Interactive Permissions, Session Model & Lifecycle", () => {
  test("async onPermissionRequest allows non-protected tools without blocking session/update and blocks protected paths", async () => {
    const dir = makeTempDir("asd-acp-interactive-");
    const mockServerPath = path.join(dir, "mock-acp-interactive.mjs");

    fs.writeFileSync(
      mockServerPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let promptMsgId = null;
const permResults = {};

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ses-int-1" } });
  } else if (msg.method === "session/prompt") {
    promptMsgId = msg.id;
    send({
      jsonrpc: "2.0",
      id: 101,
      method: "session/request_permission",
      params: {
        sessionId: "ses-int-1",
        toolCall: { toolCallId: "tc-ok", kind: "edit", title: "Edit src/ok.ts", locations: [{ path: "src/ok.ts" }] },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" }
        ]
      }
    });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses-int-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "streaming-while-pending" } }
        }
      });
    }, 15);
  } else if (msg.id === 101 && !msg.method) {
    permResults[101] = msg.result?.outcome?.optionId ?? "none";
    send({
      jsonrpc: "2.0",
      id: 102,
      method: "session/request_permission",
      params: {
        sessionId: "ses-int-1",
        toolCall: { toolCallId: "tc-env", kind: "edit", title: "Edit .env", locations: [{ path: ".env" }] },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" }
        ]
      }
    });
  } else if (msg.id === 102 && !msg.method) {
    permResults[102] = msg.result?.outcome?.optionId ?? "none";
    send({
      jsonrpc: "2.0",
      id: 103,
      method: "session/request_permission",
      params: {
        sessionId: "ses-int-1",
        toolCall: { toolCallId: "tc-git", kind: "edit", title: "Edit .git/config", locations: [{ path: ".git/config" }] },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" }
        ]
      }
    });
  } else if (msg.id === 103 && !msg.method) {
    permResults[103] = msg.result?.outcome?.optionId ?? "none";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-int-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "|101=" + permResults[101] + "|102=" + permResults[102] + "|103=" + permResults[103] }
        }
      }
    });
    send({ jsonrpc: "2.0", id: promptMsgId, result: { stopReason: "end_turn" } });
  }
});
      `.trim()
    );

    const events: AcpNormalizedEvent[] = [];
    const seenPermTitles: string[] = [];
    let resolveStreamingSeen: (() => void) | null = null;
    const streamingSeenPromise = new Promise<void>((resolve) => {
      resolveStreamingSeen = resolve;
    });

    const client = new AcpStdioClient({
      command: process.execPath,
      args: [mockServerPath],
      cwd: dir,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.category === "text" && ev.text === "streaming-while-pending") {
          resolveStreamingSeen?.();
        }
      },
      onPermissionRequest: async (params) => {
        seenPermTitles.push(params.toolCall?.title ?? "");
        // Wait for session/update chunk to prove handleLine is not blocked while awaiting
        await streamingSeenPromise;
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      },
    });

    try {
      await client.connect();
      const { sessionId } = await client.startOrLoadSession({ cwd: dir });
      const turn = await client.promptTurn(sessionId, "Test interactive perms");
      assert.equal(turn.stopReason, "end_turn");

      assert.deepEqual(seenPermTitles, ["Edit src/ok.ts"]);
      const fullText = events
        .filter((e) => e.category === "text")
        .map((e) => e.text ?? "")
        .join("");
      assert.equal(fullText, "streaming-while-pending|101=allow_once|102=reject_once|103=reject_once");

      const permEvents = events.filter((e) => e.category === "permission");
      assert.equal(permEvents.length, 3);
      assert.equal(permEvents[0]?.permissionDecision, "allowed");
      assert.equal(permEvents[1]?.permissionDecision, "denied");
      assert.ok((permEvents[1]?.permissionReason ?? "").includes(".env"));
      assert.equal(permEvents[2]?.permissionDecision, "denied");
      assert.ok((permEvents[2]?.permissionReason ?? "").includes(".git"));
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancelSession(sessionId) cancels in-flight onPermissionRequest cleanly with outcome cancelled", async () => {
    const dir = makeTempDir("asd-acp-perm-cancel-");
    const mockServerPath = path.join(dir, "mock-acp-perm-cancel.mjs");

    fs.writeFileSync(
      mockServerPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let promptMsgId = null;
const perm201Responses = [];
let sawCancelNotification = false;

function maybeFinish() {
  if (perm201Responses.length > 0 && sawCancelNotification && promptMsgId !== null) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-cancel-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ count: perm201Responses.length, outcome: perm201Responses[0]?.outcome?.outcome }) }
        }
      }
    });
    send({ jsonrpc: "2.0", id: promptMsgId, result: { stopReason: "cancelled" } });
  }
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ses-cancel-1" } });
  } else if (msg.method === "session/prompt") {
    promptMsgId = msg.id;
    send({
      jsonrpc: "2.0",
      id: 201,
      method: "session/request_permission",
      params: {
        sessionId: "ses-cancel-1",
        toolCall: { toolCallId: "tc-wait", kind: "edit", title: "Edit src/wait.ts", locations: [{ path: "src/wait.ts" }] },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" }
        ]
      }
    });
  } else if (msg.id === 201 && !msg.method) {
    perm201Responses.push(msg.result);
    maybeFinish();
  } else if (msg.method === "session/cancel") {
    sawCancelNotification = true;
    maybeFinish();
  }
});
      `.trim()
    );

    const events: AcpNormalizedEvent[] = [];
    let resolveEntered: (() => void) | null = null;
    const enteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const lateBox: {
      resolve?: (res: { outcome: { outcome: "selected"; optionId: string } }) => void;
    } = {};

    const client = new AcpStdioClient({
      command: process.execPath,
      args: [mockServerPath],
      cwd: dir,
      onEvent: (ev) => events.push(ev),
      onPermissionRequest: () => {
        resolveEntered?.();
        return new Promise((resolve) => {
          lateBox.resolve = resolve;
        });
      },
    });

    try {
      await client.connect();
      const { sessionId } = await client.startOrLoadSession({ cwd: dir });
      const turnPromise = client.promptTurn(sessionId, "Wait on permission");

      await enteredPromise;
      client.cancelSession(sessionId);

      // Even if late resolution happens afterwards, double-response must be prevented
      lateBox.resolve?.({ outcome: { outcome: "selected", optionId: "allow_once" } });

      const turn = await turnPromise;
      assert.equal(turn.stopReason, "cancelled");

      const textOut = events
        .filter((e) => e.category === "text")
        .map((e) => e.text ?? "")
        .join("");
      assert.deepEqual(JSON.parse(textOut), { count: 1, outcome: "cancelled" });

      const permEvents = events.filter((e) => e.category === "permission");
      assert.equal(permEvents.length, 1);
      assert.equal(permEvents[0]?.permissionDecision, "denied");
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setSessionModel resolves from cached catalog, setTurnHandlers swaps callbacks, and isConnected tracks lifecycle", async () => {
    const dir = makeTempDir("asd-acp-model-lifecycle-");
    const mockServerPath = path.join(dir, "mock-acp-model.mjs");

    fs.writeFileSync(
      mockServerPath,
      `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

const recordedCalls = [];

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    const sid = recordedCalls.length === 0 ? "ses-cat-1" : "ses-cat-2";
    if (sid === "ses-cat-1") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: sid,
          models: {
            availableModels: [
              { modelId: "gemini-3.8-flash-medium" },
              { modelId: "gemini-4-carbon-high" }
            ]
          },
          configOptions: [
            {
              id: "thought_level",
              category: "thought_level",
              options: [{ value: "low" }, { value: "high" }]
            }
          ]
        }
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: sid,
          configOptions: [
            {
              id: "model",
              category: "model",
              options: [{ value: "nvidia/z-ai/glm-5.3-flash" }]
            }
          ]
        }
      });
    }
  } else if (msg.method === "session/set_model") {
    recordedCalls.push({ method: "session/set_model", params: msg.params });
    if (msg.params.sessionId === "ses-cat-2") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "set_model unsupported" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  } else if (msg.method === "session/set_config_option") {
    recordedCalls.push({ method: "session/set_config_option", params: msg.params });
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(recordedCalls) }
        }
      }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
      `.trim()
    );

    const turn1Events: AcpNormalizedEvent[] = [];
    const turn2Events: AcpNormalizedEvent[] = [];

    const client = new AcpStdioClient({
      command: process.execPath,
      args: [mockServerPath],
      cwd: dir,
      onEvent: (ev) => turn1Events.push(ev),
    });

    try {
      assert.equal(client.isConnected, false);
      await client.connect();
      assert.equal(client.isConnected, true);

      const { sessionId: sid1 } = await client.startOrLoadSession({ cwd: dir });
      await client.setSessionModel(sid1, "default"); // should skip set_model
      await client.setSessionModel(sid1, "pro", "high");

      const { sessionId: sid2 } = await client.startOrLoadSession({ cwd: dir });
      await client.setSessionModel(sid2, "z-ai/glm-5.3-flash");

      // Swap handlers for next turn via setTurnHandlers
      client.setTurnHandlers({
        onEvent: (ev) => turn2Events.push(ev),
      });

      const turnRes = await client.promptTurn(sid2, "Check recorded calls");
      assert.equal(turnRes.stopReason, "end_turn");
      assert.equal(turn1Events.length, 0);
      assert.equal(turn2Events.length, 1);

      const recorded = JSON.parse(turn2Events[0]?.text ?? "[]") as Array<{
        method: string;
        params: Record<string, unknown>;
      }>;
      assert.deepEqual(recorded, [
        {
          method: "session/set_model",
          params: { sessionId: "ses-cat-1", modelId: "gemini-4-carbon-high" },
        },
        {
          method: "session/set_config_option",
          params: { sessionId: "ses-cat-1", configId: "thought_level", value: "high" },
        },
        {
          method: "session/set_model",
          params: { sessionId: "ses-cat-2", modelId: "nvidia/z-ai/glm-5.3-flash" },
        },
        {
          method: "session/set_config_option",
          params: {
            sessionId: "ses-cat-2",
            configId: "model",
            value: "nvidia/z-ai/glm-5.3-flash",
          },
        },
      ]);

      await client.close();
      assert.equal(client.isConnected, false);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executeAcpSubagentTurn extracts best-effort telemetry from ACP prompt result _meta", async () => {
    const dir = makeTempDir("asd-acp-telemetry-");
    const mockServerPath = path.join(dir, "mock-acp-telemetry.mjs");
    const logPath = path.join(dir, "output.log");

    const script = `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ses-tel-1" } });
    return;
  }
  if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-tel-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
        _meta: {
          usage: {
            input_tokens: 1500,
            output_tokens: 350,
            cache_read_input_tokens: 200,
            reasoning_tokens: 90,
          },
          cost_usd: 0.0275,
        },
      },
    });
  }
});
`;
    fs.writeFileSync(mockServerPath, script, "utf8");

    try {
      const res = await executeAcpSubagentTurn({
        harness: "claude-code",
        role: "worker",
        prompt: "Run with telemetry",
        cwd: dir,
        allowedFiles: [],
        logPath,
        commandOverride: { command: process.execPath, args: [mockServerPath] },
      });
      assert.equal(res.status, "done");
      assert.equal(res.stopReason, "end_turn");
      assert.deepEqual(res.telemetry, {
        inputTokens: 1500,
        outputTokens: 350,
        cacheTokens: 200,
        reasoningTokens: 90,
        costUsd: 0.0275,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
