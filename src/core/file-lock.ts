/**
 * Generic cross-process advisory file lock (src/core/file-lock.ts).
 *
 * Single implementation shared by the merge lock (workspace.ts, `.asd/merge.lock`)
 * and the CLI-recent lock (session-tracker.ts, `.asd/sessions/cli-recent.lock`):
 * - Create-exclusive (`wx`) lock file holding a JSON payload
 *   `{ pid, hostname, acquiredAt, purpose }`.
 * - Staleness: payload age beyond `staleMaxAgeMs`, or a dead owner PID, or an
 *   empty/unparseable payload older than 2s (mtime-based).
 * - Re-entrant within the process: a per-lock-path depth map lets nested
 *   acquisitions (sync or async) run inline without touching the lock file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface LockFilePayload {
  pid: number;
  hostname: string;
  acquiredAt: number;
  purpose: string;
  /** Per-owner random nonce to detect PID reuse and enable re-entrancy verification. */
  nonce: string;
  /** Timestamp of the last heartbeat refresh by the lock owner. */
  lastHeartbeatAt: number;
}

export interface FileLockConfig {
  /** Absolute lock file path (e.g. `<projectRoot>/.asd/merge.lock`). */
  lockPath: string;
  /** Payload age beyond this is stale even if the owner PID is still alive. */
  staleMaxAgeMs: number;
  /** Error label thrown when acquisition exceeds the timeout. */
  timeoutError: string;
  backoffBaseMs: number;
  backoffFactor: number;
  backoffCapMs: number;
  /** Interval at which the lock owner refreshes the heartbeat (ms). Default: 1000. */
  heartbeatIntervalMs?: number;
  /** Heartbeat staleness multiplier: lock is reclaimable if heartbeat older than heartbeatIntervalMs * heartbeatStaleFactor. Default: 3. */
  heartbeatStaleFactor?: number;
}

const heldLockDepth = new Map<string, number>();
const heartbeatTimers = new Map<string, NodeJS.Timeout>();

function lockKey(lockPath: string): string {
  const resolved = path.resolve(lockPath).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

function readLockPayload(lockPath: string): LockFilePayload | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as LockFilePayload;
  } catch {
    return null;
  }
}

function writeLockPayload(lockPath: string, payload: LockFilePayload): void {
  fs.writeFileSync(lockPath, JSON.stringify(payload) + "\n", "utf8");
}

export function isLockFileStale(
  lockPath: string,
  now: number,
  staleMaxAgeMs: number,
  heartbeatIntervalMs: number,
  heartbeatStaleFactor: number
): boolean {
  const payload = readLockPayload(lockPath);
  if (!payload) {
    try {
      const stat = fs.statSync(lockPath);
      return now - stat.mtimeMs > 2_000;
    } catch {
      return false;
    }
  }

  const pid = typeof payload.pid === "number" ? payload.pid : -1;
  const acquiredAt = typeof payload.acquiredAt === "number" ? payload.acquiredAt : 0;
  const lastHeartbeatAt = typeof payload.lastHeartbeatAt === "number" ? payload.lastHeartbeatAt : acquiredAt;

  if (now - acquiredAt > staleMaxAgeMs) {
    return true;
  }
  if (!isPidAlive(pid)) {
    return true;
  }
  const heartbeatStaleMs = heartbeatIntervalMs * heartbeatStaleFactor;
  if (now - lastHeartbeatAt > heartbeatStaleMs) {
    return true;
  }
  return false;
}

function tryOpenLockFile(lockPath: string, purpose: string): LockFilePayload | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, "wx");
    const now = Date.now();
    const payload: LockFilePayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: now,
      purpose,
      nonce: crypto.randomBytes(8).toString("hex"),
      lastHeartbeatAt: now,
    };
    fs.writeFileSync(fd, JSON.stringify(payload) + "\n", "utf8");
    return payload;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      return null;
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function releaseLockFile(lockPath: string, expectedNonce?: string): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const payload = readLockPayload(lockPath);
    if (!payload) return;
    if (payload.pid === process.pid && (!expectedNonce || payload.nonce === expectedNonce)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

function startHeartbeat(lockPath: string, nonce: string, intervalMs: number): void {
  const timer = setInterval(() => {
    try {
      const payload = readLockPayload(lockPath);
      if (payload && payload.nonce === nonce && payload.pid === process.pid) {
        payload.lastHeartbeatAt = Date.now();
        writeLockPayload(lockPath, payload);
      } else {
        clearInterval(timer);
        heartbeatTimers.delete(lockKey(lockPath));
      }
    } catch {
      clearInterval(timer);
      heartbeatTimers.delete(lockKey(lockPath));
    }
  }, intervalMs);
  timer.unref();
  heartbeatTimers.set(lockKey(lockPath), timer);
}

function stopHeartbeat(lockPath: string): void {
  const key = lockKey(lockPath);
  const timer = heartbeatTimers.get(key);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(key);
  }
}

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback
    }
  }
}

/**
 * Blocking re-entrant file lock. Mirrors the previous per-module
 * implementations: same acquire loop, backoff curve, staleness rules, and
 * `config.timeoutError` label on timeout.
 */
export function withFileLockSync<T>(
  config: FileLockConfig,
  purpose: string,
  timeoutMs: number,
  fn: () => T
): T {
  const key = lockKey(config.lockPath);
  const currentDepth = heldLockDepth.get(key) ?? 0;
  if (currentDepth > 0) {
    heldLockDepth.set(key, currentDepth + 1);
    try {
      return fn();
    } finally {
      heldLockDepth.set(key, currentDepth);
    }
  }

  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 1000;
  const heartbeatStaleFactor = config.heartbeatStaleFactor ?? 3;
  const start = Date.now();
  let attempt = 0;
  let acquiredPayload: LockFilePayload | null = null;
  while (true) {
    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= timeoutMs) {
      throw new Error(config.timeoutError);
    }
    acquiredPayload = tryOpenLockFile(config.lockPath, purpose);
    if (acquiredPayload) {
      break;
    }
    if (isLockFileStale(config.lockPath, now, config.staleMaxAgeMs, heartbeatIntervalMs, heartbeatStaleFactor)) {
      try {
        fs.unlinkSync(config.lockPath);
      } catch {
        // ignore race
      }
      continue;
    }
    const backoff = Math.min(
      config.backoffCapMs,
      config.backoffBaseMs * Math.pow(config.backoffFactor, attempt)
    );
    const waitMs = Math.min(backoff, Math.max(1, timeoutMs - elapsed));
    attempt++;
    sleepSync(waitMs);
  }

  heldLockDepth.set(key, 1);
  startHeartbeat(config.lockPath, acquiredPayload!.nonce, heartbeatIntervalMs);
  try {
    return fn();
  } finally {
    heldLockDepth.delete(key);
    stopHeartbeat(config.lockPath);
    releaseLockFile(config.lockPath, acquiredPayload!.nonce);
  }
}

/**
 * Non-blocking (Promise-based) re-entrant file lock with the same acquisition
 * semantics as `withFileLockSync`, sharing its depth map so nested sync/async
 * acquisitions of the same lock path never deadlock.
 */
export async function withFileLockAsync<T>(
  config: FileLockConfig,
  purpose: string,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const key = lockKey(config.lockPath);
  const currentDepth = heldLockDepth.get(key) ?? 0;
  if (currentDepth > 0) {
    heldLockDepth.set(key, currentDepth + 1);
    try {
      return await fn();
    } finally {
      heldLockDepth.set(key, currentDepth);
    }
  }

  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 1000;
  const heartbeatStaleFactor = config.heartbeatStaleFactor ?? 3;
  const start = Date.now();
  let attempt = 0;
  let acquiredPayload: LockFilePayload | null = null;
  while (true) {
    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= timeoutMs) {
      throw new Error(config.timeoutError);
    }
    acquiredPayload = tryOpenLockFile(config.lockPath, purpose);
    if (acquiredPayload) {
      break;
    }
    if (isLockFileStale(config.lockPath, now, config.staleMaxAgeMs, heartbeatIntervalMs, heartbeatStaleFactor)) {
      try {
        fs.unlinkSync(config.lockPath);
      } catch {
        // ignore race
      }
      continue;
    }
    const backoff = Math.min(
      config.backoffCapMs,
      config.backoffBaseMs * Math.pow(config.backoffFactor, attempt)
    );
    const waitMs = Math.min(backoff, Math.max(1, timeoutMs - elapsed));
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  heldLockDepth.set(key, 1);
  startHeartbeat(config.lockPath, acquiredPayload!.nonce, heartbeatIntervalMs);
  try {
    return await fn();
  } finally {
    heldLockDepth.delete(key);
    stopHeartbeat(config.lockPath);
    releaseLockFile(config.lockPath, acquiredPayload!.nonce);
  }
}
