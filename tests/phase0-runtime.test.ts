/**
 * Phase 0 runtime tests:
 *  1. Direct .ts execution with zero ExperimentalWarning on stderr.
 *  2. node:sqlite in-memory: WAL/busy_timeout pragmas + BEGIN IMMEDIATE round-trip.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const typesUrl = pathToFileURL(path.join(projectRoot, "src", "core", "types.ts")).href;

const children: ChildProcess[] = [];

after(() => {
  for (const child of children) killTree(child);
});

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

describe("phase 0 runtime", () => {
  test("direct .ts execution succeeds with zero ExperimentalWarning on stderr", async () => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(typesUrl)}); console.log("types-loaded:" + m.ASD_VERSION);`,
      ],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve)
    );
    assert.equal(code, 0);
    assert.ok(stdout.includes("types-loaded:"), `stdout: ${stdout}`);
    assert.equal(
      stderr.includes("ExperimentalWarning"),
      false,
      `stderr must have no ExperimentalWarning: ${stderr}`
    );
  });

  test("node:sqlite in-memory: WAL/busy_timeout pragmas + BEGIN IMMEDIATE round-trip", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const pragma = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(pragma.timeout, 5000);
    db.exec("BEGIN IMMEDIATE;");
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    db.exec("INSERT INTO sample (name) VALUES ('asd');");
    db.exec("COMMIT;");
    const saved = db
      .prepare("SELECT name FROM sample WHERE id = 1")
      .get() as { name: string };
    assert.equal(saved.name, "asd");
    db.close();
  });
});
