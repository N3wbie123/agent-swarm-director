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

export interface LockFilePayload {
  pid: number;
  hostname: string;
  acquiredAt: number;
  purpose: string;
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
}

const heldLockDepth = new Map<string, number>();

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

function isLockFileStale(
  lockPath: string,
  now: number,
  staleMaxAgeMs: number
): boolean {
  let raw = "";
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }

  if (!raw.trim()) {
    try {
      const stat = fs.statSync(lockPath);
      return now - stat.mtimeMs > 2_000;
    } catch {
      return false;
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    const pid = typeof parsed.pid === "number" ? parsed.pid : -1;
    const acquiredAt = typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : 0;
    if (now - acquiredAt > staleMaxAgeMs) {
      return true;
    }
    if (!isPidAlive(pid)) {
      return true;
    }
    return false;
  } catch {
    try {
      const stat = fs.statSync(lockPath);
      return now - stat.mtimeMs > 2_000;
    } catch {
      return false;
    }
  }
}

function tryOpenLockFile(lockPath: string, purpose: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, "wx");
    const payload: LockFilePayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
      purpose,
    };
    fs.writeFileSync(fd, JSON.stringify(payload) + "\n", "utf8");
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      return false;
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

function releaseLockFile(lockPath: string): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (parsed.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
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

  const start = Date.now();
  let attempt = 0;
  while (true) {
    if (tryOpenLockFile(config.lockPath, purpose)) {
      break;
    }
    const now = Date.now();
    if (isLockFileStale(config.lockPath, now, config.staleMaxAgeMs)) {
      try {
        fs.unlinkSync(config.lockPath);
      } catch {
        // ignore race
      }
      continue;
    }
    const elapsed = now - start;
    if (elapsed >= timeoutMs) {
      throw new Error(config.timeoutError);
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
  try {
    return fn();
  } finally {
    heldLockDepth.delete(key);
    releaseLockFile(config.lockPath);
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

  const start = Date.now();
  let attempt = 0;
  while (true) {
    if (tryOpenLockFile(config.lockPath, purpose)) {
      break;
    }
    const now = Date.now();
    if (isLockFileStale(config.lockPath, now, config.staleMaxAgeMs)) {
      try {
        fs.unlinkSync(config.lockPath);
      } catch {
        // ignore race
      }
      continue;
    }
    const elapsed = now - start;
    if (elapsed >= timeoutMs) {
      throw new Error(config.timeoutError);
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
  try {
    return await fn();
  } finally {
    heldLockDepth.delete(key);
    releaseLockFile(config.lockPath);
  }
}
