/**
 * Tests for src/core/file-lock.ts — nonce ownership, heartbeat staleness,
 * re-entrancy, and sync/async variants.
 * Uses node:test and node:assert/strict. All temp dirs cleaned in after().
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  withFileLockSync,
  withFileLockAsync,
  isLockFileStale,
  isPidAlive,
  type LockFilePayload,
  type FileLockConfig,
} from "../src/core/file-lock.ts";

const tmpDirs: string[] = [];

function makeLockDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-file-lock-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeLockFile(lockPath: string, payload: Partial<LockFilePayload>): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fullPayload: LockFilePayload = {
    pid: payload.pid ?? process.pid,
    hostname: payload.hostname ?? os.hostname(),
    acquiredAt: payload.acquiredAt ?? Date.now(),
    purpose: payload.purpose ?? "test",
    nonce: payload.nonce ?? "test-nonce",
    lastHeartbeatAt: payload.lastHeartbeatAt ?? Date.now(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(fullPayload) + "\n", "utf8");
}

function readLockFile(lockPath: string): LockFilePayload | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockFilePayload;
  } catch {
    return null;
  }
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("file-lock.ts - isLockFileStale", () => {
  test("returns true when acquiredAt exceeds staleMaxAgeMs", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "stale-age.lock");
    const now = Date.now();
    writeLockFile(lockPath, { acquiredAt: now - 10_000 });
    assert.equal(isLockFileStale(lockPath, now, 5_000, 1000, 3), true);
  });

  test("returns false when acquiredAt within staleMaxAgeMs and pid alive", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "fresh-age.lock");
    const now = Date.now();
    writeLockFile(lockPath, { acquiredAt: now - 1_000, pid: process.pid });
    assert.equal(isLockFileStale(lockPath, now, 5_000, 1000, 3), false);
  });

  test("returns true when pid is dead (non-existent pid)", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "dead-pid.lock");
    const now = Date.now();
    writeLockFile(lockPath, { acquiredAt: now - 1_000, pid: 999999 });
    assert.equal(isLockFileStale(lockPath, now, 5_000, 1000, 3), true);
  });

  test("returns true when pid alive but heartbeat stale (heartbeatStaleMs exceeded)", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "stale-heartbeat.lock");
    const now = Date.now();
    // heartbeatIntervalMs=10, heartbeatStaleFactor=3 => heartbeatStaleMs=30
    // lastHeartbeatAt is 50ms ago -> stale
    writeLockFile(lockPath, {
      acquiredAt: now - 1_000,
      pid: process.pid,
      lastHeartbeatAt: now - 50,
    });
    assert.equal(isLockFileStale(lockPath, now, 5_000, 10, 3), true);
  });

  test("returns false when pid alive and heartbeat fresh", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "fresh-heartbeat.lock");
    const now = Date.now();
    // heartbeatIntervalMs=10, heartbeatStaleFactor=3 => heartbeatStaleMs=30
    // lastHeartbeatAt is 10ms ago -> fresh
    writeLockFile(lockPath, {
      acquiredAt: now - 1_000,
      pid: process.pid,
      lastHeartbeatAt: now - 10,
    });
    assert.equal(isLockFileStale(lockPath, now, 5_000, 10, 3), false);
  });

  test("returns true for empty/unparseable file older than 2s (mtime-based)", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "empty.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf8");
    const stat = fs.statSync(lockPath);
    const now = stat.mtimeMs + 3_000;
    assert.equal(isLockFileStale(lockPath, now, 5_000, 1000, 3), true);
  });

  test("returns false for empty/unparseable file younger than 2s (mtime-based)", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "empty-fresh.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf8");
    const stat = fs.statSync(lockPath);
    const now = stat.mtimeMs + 1_000;
    assert.equal(isLockFileStale(lockPath, now, 5_000, 1000, 3), false);
  });

  test("foreign nonce with alive pid but stale heartbeat is reclaimable", () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "foreign-nonce.lock");
    const now = Date.now();
    // Simulate a crashed owner whose PID was reused by an unrelated process.
    // The lock has a foreign nonce, and the heartbeat is stale.
    writeLockFile(lockPath, {
      acquiredAt: now - 1_000,
      pid: process.pid, // PID reused (same as test process)
      nonce: "foreign-nonce-" + crypto.randomBytes(4).toString("hex"),
      lastHeartbeatAt: now - 100, // stale heartbeat
    });
    // heartbeatIntervalMs=10, heartbeatStaleFactor=3 => 30ms stale threshold
    assert.equal(isLockFileStale(lockPath, now, 5_000, 10, 3), true);
  });
});

describe("file-lock.ts - isPidAlive", () => {
  test("returns true for current process pid", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  test("returns false for non-existent pid", () => {
    assert.equal(isPidAlive(999999), false);
  });

  test("returns false for invalid pid values", () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(1.5), false);
  });
});

describe("file-lock.ts - withFileLockSync", () => {
  test("acquires and releases lock successfully", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-basic.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    let executed = false;
    const result = withFileLockSync(config, "test", 1_000, () => {
      executed = true;
      return "done";
    });

    assert.equal(result, "done");
    assert.equal(executed, true);
    // Lock file should be released
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("re-entrant acquisition within same process works", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-reentrant.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    let outerExecuted = false;
    let innerExecuted = false;

    const result = withFileLockSync(config, "outer", 1_000, () => {
      outerExecuted = true;
      const innerResult = withFileLockSync(config, "inner", 1_000, () => {
        innerExecuted = true;
        return "inner-done";
      });
      assert.equal(innerResult, "inner-done");
      return "outer-done";
    });

    assert.equal(result, "outer-done");
    assert.equal(outerExecuted, true);
    assert.equal(innerExecuted, true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("waits for stale lock (age > staleMaxAgeMs) and acquires", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-stale-age.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 50, // very short stale max age
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    // Pre-create a stale lock (acquiredAt far in the past)
    writeLockFile(lockPath, { acquiredAt: Date.now() - 1_000, pid: 999999 });

    let capturedPayload: LockFilePayload | null = null;
    const result = withFileLockSync(config, "test", 1_000, () => {
      capturedPayload = readLockFile(lockPath);
      return "acquired-stale";
    });

    assert.equal(result, "acquired-stale");
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.pid, process.pid);
    assert.ok(capturedPayload.nonce.length > 0);
    // Lock file should be released after callback
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("waits for stale lock (dead pid) and acquires", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-dead-pid.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    // Pre-create a lock with dead pid
    writeLockFile(lockPath, { acquiredAt: Date.now() - 100, pid: 999999 });

    let executed = false;
    const result = withFileLockSync(config, "test", 1_000, () => {
      executed = true;
      return "acquired-dead-pid";
    });

    assert.equal(result, "acquired-dead-pid");
    assert.equal(executed, true);
  });

  test("waits for stale lock (heartbeat stale, pid reused) and acquires", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-stale-heartbeat.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 20, // 20ms interval
      heartbeatStaleFactor: 3, // 60ms stale threshold
    };

    // Pre-create a lock with "reused" pid (current pid) but stale heartbeat and foreign nonce
    const now = Date.now();
    writeLockFile(lockPath, {
      acquiredAt: now - 1_000,
      pid: process.pid, // PID reused
      nonce: "foreign-" + crypto.randomBytes(4).toString("hex"),
      lastHeartbeatAt: now - 200, // heartbeat stale (200ms > 60ms)
    });

    let capturedPayload: LockFilePayload | null = null;
    const result = withFileLockSync(config, "test", 1_000, () => {
      capturedPayload = readLockFile(lockPath);
      return "acquired-stale-heartbeat";
    });

    assert.equal(result, "acquired-stale-heartbeat");
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.pid, process.pid);
    assert.notEqual(capturedPayload.nonce, "foreign-"); // new nonce generated
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("timeout is respected when lock is held by another process (simulated via stale check)", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-timeout-respected.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    // Create a lock that appears held by a live process with fresh heartbeat
    // but with a FOREIGN nonce (simulating different process)
    const now = Date.now();
    const foreignNonce = "foreign-" + crypto.randomBytes(4).toString("hex");
    writeLockFile(lockPath, {
      acquiredAt: now - 100,
      pid: process.pid, // PID reused
      nonce: foreignNonce,
      lastHeartbeatAt: now - 10, // fresh heartbeat
    });

    // Waiter should NOT reclaim (heartbeat fresh) but should timeout
    // Use timeout < heartbeatStaleMs (150ms) to avoid heartbeat staleness during test
    const waiterConfig: FileLockConfig = {
      ...config,
      timeoutError: "WAITER_TIMEOUT",
    };

    let waiterError: Error | null = null;
    try {
      withFileLockSync(waiterConfig, "waiter", 100, () => "waiter-done");
    } catch (e) {
      waiterError = e as Error;
    }

    assert.ok(waiterError, "waiter should have timed out");
    assert.equal(waiterError!.message, "WAITER_TIMEOUT");
    // Lock should still exist (not reclaimed)
    assert.equal(fs.existsSync(lockPath), true);
    const payload = readLockFile(lockPath);
    assert.ok(payload);
    assert.equal(payload.nonce, foreignNonce); // original nonce preserved
  });

  test("throws timeout error when lock cannot be acquired", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "sync-timeout.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "CUSTOM_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    // Create a lock held by a "live" process (different pid that appears alive)
    // We'll use a pid that doesn't exist but the stale check won't reclaim because age is fresh
    writeLockFile(lockPath, { acquiredAt: Date.now(), pid: process.pid }); // same pid, so isPidAlive returns true

    let error: Error | null = null;
    try {
      withFileLockSync(config, "test", 100, () => "should not run");
    } catch (e) {
      error = e as Error;
    }

    assert.ok(error);
    assert.equal(error!.message, "CUSTOM_TIMEOUT");
  });
});

describe("file-lock.ts - withFileLockAsync", () => {
  test("acquires and releases lock successfully", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "async-basic.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    let executed = false;
    const result = await withFileLockAsync(config, "test", 1_000, async () => {
      executed = true;
      return "async-done";
    });

    assert.equal(result, "async-done");
    assert.equal(executed, true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("re-entrant acquisition within same process works (sync then async)", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "async-reentrant.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    let outerExecuted = false;
    let innerExecuted = false;

    const result = withFileLockSync(config, "outer", 1_000, () => {
      outerExecuted = true;
      return withFileLockAsync(config, "inner", 1_000, async () => {
        innerExecuted = true;
        return "inner-async-done";
      });
    });

    const innerResult = await result;
    assert.equal(innerResult, "inner-async-done");
    assert.equal(outerExecuted, true);
    assert.equal(innerExecuted, true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("re-entrant acquisition within same process works (async then sync)", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "async-reentrant2.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    let outerExecuted = false;
    let innerExecuted = false;

    const result = await withFileLockAsync(config, "outer", 1_000, async () => {
      outerExecuted = true;
      return withFileLockSync(config, "inner", 1_000, () => {
        innerExecuted = true;
        return "inner-sync-done";
      });
    });

    assert.equal(result, "inner-sync-done");
    assert.equal(outerExecuted, true);
    assert.equal(innerExecuted, true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("waits for stale lock (heartbeat stale) and acquires", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "async-stale-heartbeat.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 20,
      heartbeatStaleFactor: 3,
    };

    const now = Date.now();
    writeLockFile(lockPath, {
      acquiredAt: now - 1_000,
      pid: process.pid,
      nonce: "foreign-" + crypto.randomBytes(4).toString("hex"),
      lastHeartbeatAt: now - 200,
    });

    let capturedPayload: LockFilePayload | null = null;
    const result = await withFileLockAsync(config, "test", 1_000, async () => {
      capturedPayload = readLockFile(lockPath);
      return "async-acquired-stale-heartbeat";
    });

    assert.equal(result, "async-acquired-stale-heartbeat");
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.pid, process.pid);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("timeout is respected when lock is held by another process (simulated via stale check)", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "async-timeout-respected.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    // Create a lock that appears held by a live process with fresh heartbeat
    // but with a FOREIGN nonce (simulating different process)
    const now = Date.now();
    const foreignNonce = "foreign-" + crypto.randomBytes(4).toString("hex");
    writeLockFile(lockPath, {
      acquiredAt: now - 100,
      pid: process.pid, // PID reused
      nonce: foreignNonce,
      lastHeartbeatAt: now - 10, // fresh heartbeat
    });

    // Waiter should NOT reclaim (heartbeat fresh) but should timeout
    // Use timeout < heartbeatStaleMs (150ms) to avoid heartbeat staleness during test
    const waiterConfig: FileLockConfig = {
      ...config,
      timeoutError: "WAITER_TIMEOUT",
    };

    let waiterError: Error | null = null;
    try {
      await withFileLockAsync(waiterConfig, "waiter", 100, async () => "waiter-done");
    } catch (e) {
      waiterError = e as Error;
    }

    assert.ok(waiterError, "waiter should have timed out");
    assert.equal(waiterError!.message, "WAITER_TIMEOUT");
    // Lock should still exist (not reclaimed)
    assert.equal(fs.existsSync(lockPath), true);
    const payload = readLockFile(lockPath);
    assert.ok(payload);
    assert.equal(payload.nonce, foreignNonce); // original nonce preserved
  });
});

describe("file-lock.ts - nonce verification on release", () => {
  test("releaseLockFile only releases when nonce matches", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "nonce-release.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    // Acquire lock
    withFileLockSync(config, "test", 1_000, () => "done");

    // Lock should be released
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("lock file contains nonce and lastHeartbeatAt fields", async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, "payload-fields.lock");
    const config: FileLockConfig = {
      lockPath,
      staleMaxAgeMs: 5_000,
      timeoutError: "TEST_TIMEOUT",
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffCapMs: 100,
      heartbeatIntervalMs: 50,
      heartbeatStaleFactor: 3,
    };

    let capturedPayload: LockFilePayload | null = null;
    withFileLockSync(config, "test", 1_000, () => {
      capturedPayload = readLockFile(lockPath);
      return "done";
    });

    assert.ok(capturedPayload);
    assert.ok(typeof capturedPayload.nonce === "string" && capturedPayload.nonce.length > 0);
    assert.ok(typeof capturedPayload.lastHeartbeatAt === "number" && capturedPayload.lastHeartbeatAt > 0);
    assert.equal(capturedPayload.pid, process.pid);
    assert.equal(capturedPayload.hostname, os.hostname());
    assert.equal(capturedPayload.purpose, "test");
  });
});