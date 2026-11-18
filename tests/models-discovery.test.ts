/**
 * Tests for gateway bearer-token safety in src/core/models.ts (T2.1).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverHarnessModels,
  getModelsDiskCachePath,
  writeModelsDiskCache,
} from "../src/core/models.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("models.ts - gateway token exfiltration & SSRF protection (T2.1)", () => {
  test("blocks cleartext remote http://, cloud metadata SSRF, and untrusted background gateway URLs", async () => {
    const homeDir = makeTempDir("asd-models-sec-home-");
    const projDir = makeTempDir("asd-models-sec-proj-");
    const origFetch = globalThis.fetch;
    const origAuth = process.env.ANTHROPIC_AUTH_TOKEN;
    const origBase = process.env.ANTHROPIC_BASE_URL;
    const origNv = process.env.NVIDIA_NIM_API_KEY;
    const origAllow = process.env.ASD_ALLOW_CUSTOM_GATEWAY_PROBE;

    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchedUrls.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.NVIDIA_NIM_API_KEY;
      delete process.env.ASD_ALLOW_CUSTOM_GATEWAY_PROBE;

      const claudeDir = path.join(homeDir, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      const fakeTok = ["sk-ant", "live9988776655443322"].join("-");

      // 1. Cleartext http:// on remote host -> NEVER probed even with enableGatewayProbe: true
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: fakeTok,
            ANTHROPIC_BASE_URL: "http://evil-proxy.example.com/v1",
          },
        }),
        "utf8"
      );
      await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
        enableGatewayProbe: true,
      });
      assert.equal(fetchedUrls.length, 0, "Remote cleartext http:// URL must never receive Bearer token");

      // 2. Cloud metadata SSRF IP -> NEVER probed
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: fakeTok,
            ANTHROPIC_BASE_URL: "https://169.254.169.254/latest",
          },
        }),
        "utf8"
      );
      await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
        enableGatewayProbe: true,
      });
      assert.equal(fetchedUrls.length, 0, "Metadata SSRF IP must never be probed");

      // 3. Background discovery ("trusted-only") -> blocks arbitrary custom remote hosts
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: fakeTok,
            ANTHROPIC_BASE_URL: "https://untrusted-custom.example.com/v1",
          },
        }),
        "utf8"
      );
      await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
        enableGatewayProbe: "trusted-only",
      });
      assert.equal(fetchedUrls.length, 0, "Background discovery must not send tokens to untrusted custom hosts");

      // 4. NVIDIA_NIM_API_KEY must NEVER be sent to non-NVIDIA ANTHROPIC_BASE_URL
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          env: {
            NVIDIA_NIM_API_KEY: "nvapi-" + "live9988776655443322",
            ANTHROPIC_BASE_URL: "https://my-litellm.example.com/v1",
          },
        }),
        "utf8"
      );
      await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
        enableGatewayProbe: true,
      });
      assert.equal(fetchedUrls.length, 0, "NVIDIA_NIM_API_KEY must never be sent to non-NVIDIA base URL");

      // 5. Loopback http://127.0.0.1 local LiteLLM proxy IS allowed under trusted-only discovery
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: fakeTok,
            ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/v1",
          },
        }),
        "utf8"
      );
      await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
        enableGatewayProbe: "trusted-only",
      });
      assert.equal(fetchedUrls.length, 1);
      assert.equal(fetchedUrls[0], "http://127.0.0.1:4000/v1/models");
    } finally {
      globalThis.fetch = origFetch;
      if (origAuth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origAuth;
      else delete process.env.ANTHROPIC_AUTH_TOKEN;
      if (origBase !== undefined) process.env.ANTHROPIC_BASE_URL = origBase;
      else delete process.env.ANTHROPIC_BASE_URL;
      if (origNv !== undefined) process.env.NVIDIA_NIM_API_KEY = origNv;
      else delete process.env.NVIDIA_NIM_API_KEY;
      if (origAllow !== undefined) process.env.ASD_ALLOW_CUSTOM_GATEWAY_PROBE = origAllow;
      else delete process.env.ASD_ALLOW_CUSTOM_GATEWAY_PROBE;
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test("parses opencode.jsonc with https:// URLs, comments, and trailing commas without corrupting JSON", async () => {
    const homeDir = makeTempDir("asd-models-oc-jsonc-home-");
    const projDir = makeTempDir("asd-models-oc-jsonc-proj-");
    try {
      const ocDir = path.join(homeDir, ".config", "opencode");
      fs.mkdirSync(ocDir, { recursive: true });
      fs.writeFileSync(
        path.join(ocDir, "opencode.jsonc"),
        [
          "{",
          '  "$schema": "https://opencode.ai/config.json", // schema URL with // inside string',
          '  "model": "custom/primary-model",',
          '  "small_model": "custom/small-model",',
          "  /* custom local & remote providers */",
          '  "provider": {',
          '    "llama.cpp": {',
          '      "options": { "baseURL": "http://127.0.0.1:8080/v1" },',
          '      "models": {',
          '        "gemma-4-q4": {},',
          "      },",
          "    },",
          "  },",
          "}",
        ].join("\n"),
        "utf8"
      );

      const catalog = await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
      });

      assert.ok(catalog.opencode.includes("custom/primary-model"));
      assert.ok(catalog.opencode.includes("custom/small-model"));
      assert.ok(catalog.opencode.includes("llama.cpp/gemma-4-q4"));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test("prevents background skipCliSpawn+excludeAsdRouting syncs from poisoning models-cache.json and preserves prior models on partial refresh", async () => {
    const homeDir = makeTempDir("asd-models-cache-guard-home-");
    const projDir = makeTempDir("asd-models-cache-guard-proj-");
    try {
      const prewarmed = {
        antigravity: ["gemini-4-carbon-high", "gemini-3.8-flash-medium"],
        "claude-code": ["claude-sonnet-5-5"],
        codex: ["gpt-6-luna"],
        opencode: ["opencode/glm-5.3-flash-free", "nvidia/z-ai/glm-5.3-flash"],
        cursor: ["claude-sonnet-5-5-medium", "gpt-5.3-codex-high"],
      };
      writeModelsDiskCache(homeDir, prewarmed, true);

      // Simulate normal `asd sync` (skipCliSpawn: true, excludeAsdRouting: true)
      await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: false,
        skipCliSpawn: true,
        persistCache: false,
        excludeAsdRouting: true,
      });

      const afterSyncRaw = JSON.parse(
        fs.readFileSync(getModelsDiskCachePath(homeDir), "utf8")
      ) as { catalog: typeof prewarmed };
      assert.deepEqual(
        afterSyncRaw.catalog.antigravity,
        prewarmed.antigravity,
        "Background sync must never wipe antigravity models in models-cache.json"
      );
      assert.deepEqual(
        afterSyncRaw.catalog.cursor,
        prewarmed.cursor,
        "Background sync must never wipe cursor models in models-cache.json"
      );

      // Simulate a partial refresh (e.g., CLI timed out / skipCliSpawn) while adding a new local model
      fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".codex", "models_cache.json"),
        JSON.stringify({ models: [{ slug: "gpt-6.1-preview" }] }),
        "utf8"
      );

      const merged = await discoverHarnessModels({
        projectRoot: projDir,
        homeDir,
        forceRefresh: true,
        skipCliSpawn: true,
      });
      assert.equal(merged.codex[0], "gpt-6.1-preview", "Freshly discovered model appears first");
      assert.ok(merged.codex.includes("gpt-6-luna"), "Previously cached codex model is preserved");
      assert.deepEqual(
        merged.antigravity,
        prewarmed.antigravity,
        "Previously cached antigravity models survive partial refresh"
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  test("deduplicates concurrent in-flight discoverHarnessModels requests", async () => {
    const homeDir = makeTempDir("asd-models-inflight-home-");
    const projA = makeTempDir("asd-models-inflight-a-");
    const projB = makeTempDir("asd-models-inflight-b-");
    const origFetch = globalThis.fetch;
    let fetchCount = 0;

    globalThis.fetch = (async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 40));
      return new Response(
        JSON.stringify({ data: [{ id: "inflight-shared-model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".claude", "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: ["sk-ant", "inflight123456"].join("-"),
            ANTHROPIC_BASE_URL: "http://127.0.0.1:4123/v1",
          },
        }),
        "utf8"
      );

      const [resA, resB, resC] = await Promise.all([
        discoverHarnessModels({
          projectRoot: projA,
          homeDir,
          forceRefresh: true,
          skipCliSpawn: true,
          enableGatewayProbe: "trusted-only",
        }),
        discoverHarnessModels({
          projectRoot: projB,
          homeDir,
          forceRefresh: true,
          skipCliSpawn: true,
          enableGatewayProbe: "trusted-only",
        }),
        discoverHarnessModels({
          projectRoot: projA,
          homeDir,
          forceRefresh: true,
          skipCliSpawn: true,
          enableGatewayProbe: "trusted-only",
        }),
      ]);

      assert.equal(fetchCount, 1, "Concurrent callers must share a single in-flight probe");
      assert.ok(resA["claude-code"].includes("inflight-shared-model"));
      assert.ok(resB["claude-code"].includes("inflight-shared-model"));
      assert.ok(resC["claude-code"].includes("inflight-shared-model"));
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projA, { recursive: true, force: true });
      fs.rmSync(projB, { recursive: true, force: true });
    }
  });
});
