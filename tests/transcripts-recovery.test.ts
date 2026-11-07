import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import {
  appendCursorStreamFallback,
  decompressZstdBuffer,
  locateHarnessTranscript,
  readHarnessTranscript,
} from "../src/core/transcripts.ts";

function createTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "asd-transcript-recovery-"));
}

describe("T4.1: Cursor Lossy JSONL Stream Capture Fallback", () => {
  it("returns error: 'unsupported' and found: false when no fallback exists (backward compatibility)", () => {
    const home = createTempHome();
    try {
      const loc = locateHarnessTranscript("cursor", "nonexistent-cursor-session", { homeDir: home });
      assert.equal(loc.found, false);
      assert.equal(loc.error, "unsupported");

      const res = readHarnessTranscript("cursor", "nonexistent-cursor-session", { homeDir: home });
      assert.equal(res.found, false);
      assert.equal(res.error, "unsupported");
      assert.deepEqual(res.messages, []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("locates and reads Cursor messages when fallback JSONL stream is recorded", () => {
    const home = createTempHome();
    const sessionId = "cur-test-session-001";
    try {
      const writtenPath = appendCursorStreamFallback(
        sessionId,
        [
          JSON.stringify({ type: "thinking", subtype: "delta", text: "Planning Cursor refactor" }),
          JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call_cur_1",
            tool_call: { name: "edit_file", args: { file: "src/index.ts" } },
          }),
          JSON.stringify({
            type: "tool_call",
            subtype: "completed",
            call_id: "call_cur_1",
            result: "file edited successfully",
          }),
          JSON.stringify({ type: "result", result: "Cursor changes finished." }),
        ].join("\n"),
        { homeDir: home }
      );

      assert.ok(writtenPath);
      assert.ok(fs.existsSync(writtenPath));

      const loc = locateHarnessTranscript("cursor", sessionId, { homeDir: home });
      assert.equal(loc.found, true);
      assert.equal(loc.transcriptPath, writtenPath);

      const res = readHarnessTranscript("cursor", sessionId, { homeDir: home });
      assert.equal(res.found, true);
      assert.equal(res.messages.length, 3);

      assert.equal(res.messages[0]?.category, "thinking");
      assert.equal(res.messages[0]?.thinking, "Planning Cursor refactor");

      assert.equal(res.messages[1]?.category, "tool_use");
      assert.equal(res.messages[1]?.toolUse?.[0]?.name, "edit_file");
      assert.equal(res.messages[1]?.toolResult?.[0]?.output, "file edited successfully");

      assert.equal(res.messages[2]?.category, "assistant");
      assert.equal(res.messages[2]?.text, "Cursor changes finished.");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("T4.1: Codex rollout .jsonl.zst Decompression", () => {
  it("decompressZstdBuffer handles corrupt bytes gracefully without throwing", () => {
    const corrupt = Buffer.from("this-is-not-valid-zstd-compressed-data");
    const result = decompressZstdBuffer(corrupt);
    assert.equal(result, null);
  });

  it("locates and transparently reads .jsonl.zst rollout transcripts and handles corrupt .zst gracefully", () => {
    const home = createTempHome();
    const threadId = "thread-zst-12345";
    const corruptThreadId = "thread-zst-corrupt";
    try {
      const sessionsDir = path.join(home, ".codex", "sessions", "2026", "11", "08");
      fs.mkdirSync(sessionsDir, { recursive: true });

      const corruptZst = path.join(sessionsDir, `rollout-20261108T000000-${corruptThreadId}.jsonl.zst`);
      fs.writeFileSync(corruptZst, Buffer.from("corrupt-zst-bytes"));

      const corruptLoc = locateHarnessTranscript("codex", corruptThreadId, { homeDir: home });
      assert.equal(corruptLoc.found, true);
      assert.equal(corruptLoc.transcriptPath, corruptZst);

      const corruptRes = readHarnessTranscript("codex", corruptThreadId, { homeDir: home });
      assert.equal(corruptRes.found, false);
      assert.ok(corruptRes.error);

      const zlibAny = zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer };
      if (typeof zlibAny.zstdCompressSync === "function") {
        const originalLines = [
          JSON.stringify({
            type: "event_msg",
            payload: { type: "agent_reasoning", text: "Codex reasoning over compressed rollout" },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "agent_message", message: "Task completed from zst archive" },
          }),
        ].join("\n");

        const compressed = zlibAny.zstdCompressSync(Buffer.from(originalLines, "utf8"));
        const zstPath = path.join(sessionsDir, `rollout-20261108T000000-${threadId}.jsonl.zst`);
        fs.writeFileSync(zstPath, compressed);

        const loc = locateHarnessTranscript("codex", threadId, { homeDir: home });
        assert.equal(loc.found, true);
        assert.equal(loc.transcriptPath, zstPath);

        const res = readHarnessTranscript("codex", threadId, { homeDir: home });
        assert.equal(res.found, true);
        assert.equal(res.messages.length, 2);
        assert.equal(res.messages[0]?.category, "thinking");
        assert.equal(res.messages[0]?.thinking, "Codex reasoning over compressed rollout");
        assert.equal(res.messages[1]?.category, "assistant");
        assert.equal(res.messages[1]?.text, "Task completed from zst archive");
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("T4.1: Claude Code JSONL Schema Drift Tolerance", () => {
  it("recovers messages across diverse schema drift variants without dropping valid blocks", () => {
    const home = createTempHome();
    const sessionId = "cc-drift-sess-001";
    try {
      const projDir = path.join(home, ".claude", "projects", "test-project");
      fs.mkdirSync(projDir, { recursive: true });
      const transcriptPath = path.join(projDir, `${sessionId}.jsonl`);

      const driftLines = [
        // 1. Nested object content: { text: "..." }
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: { text: "Object content variation text" },
          },
          timestamp: "2026-11-08T00:00:01Z",
        }),
        // 2. Object content with parts array and unknown block type (tool_reference)
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: {
              parts: [
                { type: "text", text: "Part one text." },
                { type: "tool_reference", id: "ref_unknown_01" },
                { type: "text", text: "Part two text." },
              ],
            },
          },
          timestamp: "2026-11-08T00:00:02Z",
        }),
        // 3. Top-level toolUseResult alongside tool message
        JSON.stringify({
          type: "tool",
          message: { role: "tool" },
          toolUseResult: {
            toolUseId: "tu_99",
            output: "Output from top-level toolUseResult",
          },
          timestamp: "2026-11-08T00:00:03Z",
        }),
        // 4. Missing message wrapper (top-level assistant text)
        JSON.stringify({
          type: "assistant",
          content: "Top-level assistant without message wrapper",
          timestamp: "2026-11-08T00:00:04Z",
        }),
        // 5. Message payload nested under `data`
        JSON.stringify({
          type: "user",
          data: {
            role: "user",
            content: "User question under data property",
          },
          timestamp: "2026-11-08T00:00:05Z",
        }),
      ];

      fs.writeFileSync(transcriptPath, driftLines.join("\n") + "\n", "utf8");

      const res = readHarnessTranscript("claude-code", sessionId, { homeDir: home });
      assert.equal(res.found, true);
      assert.equal(res.messages.length, 5);

      assert.equal(res.messages[0]?.text, "Object content variation text");
      assert.ok(res.messages[1]?.text.includes("Part one text."));
      assert.ok(res.messages[1]?.text.includes("Part two text."));
      assert.equal(res.messages[2]?.category, "tool_result");
      assert.equal(res.messages[2]?.toolResult?.[0]?.output, "Output from top-level toolUseResult");
      assert.equal(res.messages[3]?.text, "Top-level assistant without message wrapper");
      assert.equal(res.messages[4]?.text, "User question under data property");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
