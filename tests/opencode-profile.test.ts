/**
 * ASD OpenCode Version Detection & Capability Profile Tests (tests/opencode-profile.test.ts)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  buildOpenCodeCapabilityProfile,
  DEFAULT_OPENCODE_PROBE_TIMEOUT_MS,
  detectOpenCodeVersion,
  OPENCODE_VERSION_CACHE_TTL_MS,
  parseOpenCodeVersionOutput,
  resetOpenCodeVersionCache,
  resolveOpenCodeCapabilityProfile,
} from "../src/core/opencode-profile.ts";
import type { OpenCodeVersionInfo } from "../src/core/types.ts";

function writeFakeOpenCodeShim(dir: string, outputLine: string): void {
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "opencode.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\necho ${outputLine}\r\n`, "utf8");
  } else {
    const binPath = path.join(dir, "opencode");
    fs.writeFileSync(binPath, `#!/bin/sh\necho "${outputLine}"\n`, "utf8");
    fs.chmodSync(binPath, 0o755);
  }
}

describe("parseOpenCodeVersionOutput", () => {
  test("parses V1 bare semver", () => {
    assert.deepEqual(parseOpenCodeVersionOutput("1.19.4"), {
      version: "1.19.4",
      major: 1,
      pluginApi: "v1",
    });
  });

  test("parses V2 prefixed output", () => {
    assert.deepEqual(parseOpenCodeVersionOutput("opencode v2.3.2\n"), {
      version: "2.3.2",
      major: 2,
      pluginApi: "v2",
    });
  });

  test("parses leading v with pre-release and build metadata tags", () => {
    assert.deepEqual(parseOpenCodeVersionOutput("v2.4.0-rc.1+abc"), {
      version: "2.4.0-rc.1+abc",
      major: 2,
      pluginApi: "v2",
    });
    assert.deepEqual(parseOpenCodeVersionOutput("v2.0.0-beta.1+build.42"), {
      version: "2.0.0-beta.1+build.42",
      major: 2,
      pluginApi: "v2",
    });
  });

  test("parses multi-line output and prefers opencode version line", () => {
    const multiLine = [
      "Note: running with Node v22.13.0",
      "opencode v2.3.2",
      "commit: 1a2b3c4d",
    ].join("\n");
    assert.deepEqual(parseOpenCodeVersionOutput(multiLine), {
      version: "2.3.2",
      major: 2,
      pluginApi: "v2",
    });

    const multiLineV1 = [
      "OpenCode CLI",
      "1.19.4",
    ].join("\r\n");
    assert.deepEqual(parseOpenCodeVersionOutput(multiLineV1), {
      version: "1.19.4",
      major: 1,
      pluginApi: "v1",
    });
  });

  test("classifies major >= 3 as v2 and major 0 as unknown", () => {
    assert.deepEqual(parseOpenCodeVersionOutput("opencode v3.1.0"), {
      version: "3.1.0",
      major: 3,
      pluginApi: "v2",
    });
    assert.deepEqual(parseOpenCodeVersionOutput("0.9.5"), {
      version: "0.9.5",
      major: 0,
      pluginApi: "unknown",
    });
  });

  test("returns unknown for empty, null, undefined, or malformed output", () => {
    const expected = { version: null, major: null, pluginApi: "unknown" as const };
    assert.deepEqual(parseOpenCodeVersionOutput(null), expected);
    assert.deepEqual(parseOpenCodeVersionOutput(undefined), expected);
    assert.deepEqual(parseOpenCodeVersionOutput(""), expected);
    assert.deepEqual(parseOpenCodeVersionOutput("   \n\t "), expected);
    assert.deepEqual(parseOpenCodeVersionOutput("opencode unknown version"), expected);
    assert.deepEqual(parseOpenCodeVersionOutput("listening on 192.168.1.1"), expected);
  });
});

describe("detectOpenCodeVersion", () => {
  afterEach(() => {
    resetOpenCodeVersionCache();
  });

  test("respects ASD_OPENCODE_PROFILE=v1 and v2 env overrides without invoking CLI", () => {
    let calls = 0;
    const runner = () => {
      calls++;
      return { status: 0, stdout: "opencode v2.3.2", stderr: "" };
    };

    const v1 = detectOpenCodeVersion({
      env: { ASD_OPENCODE_PROFILE: "v1" },
      commandRunner: runner,
    });
    assert.deepEqual(v1, {
      rawOutput: null,
      version: null,
      major: 1,
      pluginApi: "v1",
      source: "env-override",
    });

    const v2 = detectOpenCodeVersion({
      env: { ASD_OPENCODE_PROFILE: "V2" },
      commandRunner: runner,
    });
    assert.deepEqual(v2, {
      rawOutput: null,
      version: null,
      major: 2,
      pluginApi: "v2",
      source: "env-override",
    });

    assert.strictEqual(calls, 0, "commandRunner must never be invoked when env override is set");
  });

  test("uses injectable commandRunner for V1 and V2 responses", () => {
    let seenCmd = "";
    let seenArgs: string[] = [];
    let seenTimeout = 0;

    const v1Info = detectOpenCodeVersion({
      env: {},
      timeoutMs: 1500,
      commandRunner: (cmd, args, timeoutMs) => {
        seenCmd = cmd;
        seenArgs = args;
        seenTimeout = timeoutMs;
        return { status: 0, stdout: "1.19.4\n", stderr: "" };
      },
    });

    assert.strictEqual(seenCmd, "opencode");
    assert.deepEqual(seenArgs, ["--version"]);
    assert.strictEqual(seenTimeout, 1500);
    assert.deepEqual(v1Info, {
      rawOutput: "1.19.4",
      version: "1.19.4",
      major: 1,
      pluginApi: "v1",
      source: "cli-probe",
    });

    const v2Info = detectOpenCodeVersion({
      env: {},
      commandRunner: (cmd, args, timeoutMs) => {
        seenCmd = cmd;
        seenArgs = args;
        seenTimeout = timeoutMs;
        return { status: 0, stdout: "opencode v2.3.2\n", stderr: "" };
      },
    });

    assert.strictEqual(seenTimeout, DEFAULT_OPENCODE_PROBE_TIMEOUT_MS);
    assert.deepEqual(v2Info, {
      rawOutput: "opencode v2.3.2",
      version: "2.3.2",
      major: 2,
      pluginApi: "v2",
      source: "cli-probe",
    });
  });

  test("falls back safely to unknown + V1 compatibility warning on non-zero exit, error, throw, or malformed output", () => {
    const nonZero = detectOpenCodeVersion({
      env: {},
      commandRunner: () => ({ status: 1, stdout: "", stderr: "command failed" }),
    });
    assert.strictEqual(nonZero.pluginApi, "unknown");
    assert.strictEqual(nonZero.source, "fallback");
    assert.ok(nonZero.degradedWarning && nonZero.degradedWarning.length > 0);
    const nonZeroProfile = buildOpenCodeCapabilityProfile(nonZero);
    assert.strictEqual(nonZeroProfile.effectiveProfile, "v1");
    assert.strictEqual(nonZeroProfile.degraded, true);
    assert.ok(nonZeroProfile.warning && nonZeroProfile.warning.length > 0);

    const errored = detectOpenCodeVersion({
      env: {},
      commandRunner: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("spawnSync opencode ETIMEDOUT"),
      }),
    });
    assert.strictEqual(errored.pluginApi, "unknown");
    assert.strictEqual(errored.source, "fallback");
    assert.ok(errored.degradedWarning?.includes("ETIMEDOUT"));

    const thrown = resolveOpenCodeCapabilityProfile({
      env: {},
      commandRunner: () => {
        throw new Error("unexpected probe crash");
      },
    });
    assert.strictEqual(thrown.pluginApi, "unknown");
    assert.strictEqual(thrown.effectiveProfile, "v1");
    assert.strictEqual(thrown.degraded, true);
    assert.ok(thrown.warning?.includes("unexpected probe crash"));

    const malformed = resolveOpenCodeCapabilityProfile({
      env: {},
      commandRunner: () => ({ status: 0, stdout: "not-a-semver", stderr: "" }),
    });
    assert.strictEqual(malformed.pluginApi, "unknown");
    assert.strictEqual(malformed.version.source, "fallback");
    assert.strictEqual(malformed.effectiveProfile, "v1");
    assert.strictEqual(malformed.degraded, true);
    assert.ok(malformed.warning && malformed.warning.length > 0);
  });

  test("caches default CLI probe results, supports bypassCache, resetOpenCodeVersionCache, and TTL expiry", (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-opencode-profile-"));
    try {
      t.mock.timers.enable({ apis: ["Date"] });
      writeFakeOpenCodeShim(tempDir, "opencode v2.3.2");
      const env: Record<string, string | undefined> = {
        PATH: tempDir,
        ComSpec: process.env.ComSpec,
      };

      const first = detectOpenCodeVersion({ env });
      assert.strictEqual(first.source, "cli-probe");
      assert.strictEqual(first.pluginApi, "v2");
      assert.strictEqual(first.version, "2.3.2");

      // Change shim on disk; cached result should remain v2.3.2
      writeFakeOpenCodeShim(tempDir, "1.19.4");
      const secondCached = detectOpenCodeVersion({ env });
      assert.strictEqual(secondCached.pluginApi, "v2");
      assert.strictEqual(secondCached.version, "2.3.2");

      // bypassCache forces fresh CLI execution
      const bypassed = detectOpenCodeVersion({ env, bypassCache: true });
      assert.strictEqual(bypassed.pluginApi, "v1");
      assert.strictEqual(bypassed.version, "1.19.4");

      // resetOpenCodeVersionCache clears cached entry
      writeFakeOpenCodeShim(tempDir, "opencode v2.3.2");
      assert.strictEqual(detectOpenCodeVersion({ env }).version, "1.19.4");
      resetOpenCodeVersionCache();
      assert.strictEqual(detectOpenCodeVersion({ env }).version, "2.3.2");

      // Advancing past TTL expires the cached entry
      writeFakeOpenCodeShim(tempDir, "1.19.4");
      t.mock.timers.tick(OPENCODE_VERSION_CACHE_TTL_MS + 1);
      const afterTtl = detectOpenCodeVersion({ env });
      assert.strictEqual(afterTtl.pluginApi, "v1");
      assert.strictEqual(afterTtl.version, "1.19.4");
    } finally {
      resetOpenCodeVersionCache();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildOpenCodeCapabilityProfile", () => {
  test("maps V2 version info to exact V2 capability fields", () => {
    const v2Version: OpenCodeVersionInfo = {
      rawOutput: "opencode v2.3.2",
      version: "2.3.2",
      major: 2,
      pluginApi: "v2",
      source: "cli-probe",
    };

    const profile = buildOpenCodeCapabilityProfile(v2Version);
    assert.deepEqual(profile, {
      version: v2Version,
      pluginApi: "v2",
      effectiveProfile: "v2",
      degraded: false,
      supportsNativeBackground: true,
      supportsAcp: true,
      acpArgs: ["acp"],
      headlessRunFlags: ["--auto"],
      supportsModelsCmd: true,
      pluginDirName: "plugins",
      pluginRelativePath: "plugins/asd-guard/index.js",
      serverEventPath: "/api/event",
      serverAbortPathTemplate: "/api/session/{sessionId}/interrupt",
      usesV1SessionCallback: false,
    });
  });

  test("maps V1 version info to exact V1 capability fields with degraded=false", () => {
    const v1Version: OpenCodeVersionInfo = {
      rawOutput: "1.19.4",
      version: "1.19.4",
      major: 1,
      pluginApi: "v1",
      source: "cli-probe",
    };

    const profile = buildOpenCodeCapabilityProfile(v1Version);
    assert.deepEqual(profile, {
      version: v1Version,
      pluginApi: "v1",
      effectiveProfile: "v1",
      degraded: false,
      supportsNativeBackground: false,
      supportsAcp: true,
      acpArgs: ["acp", "--pure"],
      headlessRunFlags: ["--pure"],
      supportsModelsCmd: true,
      pluginDirName: "plugin",
      pluginRelativePath: "plugin/asd-guard.js",
      serverEventPath: "/event",
      serverAbortPathTemplate: "/session/{sessionId}/abort",
      usesV1SessionCallback: true,
    });
  });

  test("maps unknown version info to safe V1 fallback with degraded=true and non-empty warning", () => {
    const unknownWithoutWarning: OpenCodeVersionInfo = {
      rawOutput: null,
      version: null,
      major: null,
      pluginApi: "unknown",
      source: "fallback",
    };

    const profile = buildOpenCodeCapabilityProfile(unknownWithoutWarning);
    assert.strictEqual(profile.effectiveProfile, "v1");
    assert.strictEqual(profile.degraded, true);
    assert.ok(profile.warning && profile.warning.length > 0);
    assert.deepEqual(profile.acpArgs, ["acp", "--pure"]);
    assert.deepEqual(profile.headlessRunFlags, ["--pure"]);
    assert.strictEqual(profile.pluginDirName, "plugin");
    assert.strictEqual(profile.pluginRelativePath, "plugin/asd-guard.js");
    assert.strictEqual(profile.serverEventPath, "/event");
    assert.strictEqual(profile.serverAbortPathTemplate, "/session/{sessionId}/abort");
    assert.strictEqual(profile.usesV1SessionCallback, true);
    assert.strictEqual(profile.supportsNativeBackground, false);
  });
});
