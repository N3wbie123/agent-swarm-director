/**
 * Tests for gateway bearer-token safety in src/core/models.ts (T2.1).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverHarnessModels } from "../src/core/models.ts";

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
});
