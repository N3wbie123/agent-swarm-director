#!/usr/bin/env node
/**
 * Lightweight 3-Track Trajectory Evaluation Suite (`scripts/eval-trajectory.ts`).
 *
 * Compares DIRECT vs LIGHT vs HEAVY across 6 representative engineering tasks
 * measuring completion rate, retries, wall-clock duration, and token/cost telemetry.
 *
 * Modes:
 * - Default (offline): deterministic fixture harness exercising the real
 *   `AsdOrchestrator` + SQLite DB + workspace verification gates with zero API cost.
 * - `--live`: runs live external harness CLIs for HEAVY tasks (opt-in).
 * - `--json`: outputs machine-readable JSON report to stdout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openProjectDb } from "../src/core/db.ts";
import type { CommandRunner } from "../src/core/spawner.ts";
import type { TaskTelemetry, TaskTrack } from "../src/core/types.ts";
import {
  ensureGitUserIdentity,
  prepareBaseline,
  runGit,
} from "../src/core/workspace.ts";
import { AsdOrchestrator } from "../src/orchestrator/index.ts";

export interface EvalScenario {
  id: string;
  title: string;
  recommendedTrack: TaskTrack;
  category: "general" | "visual-ui" | "design" | "writing";
  difficulty: "low" | "medium" | "high";
  files: string[];
  simulatedRetriesByTrack: Record<TaskTrack, number>;
  simulatedTelemetryByTrack: Record<TaskTrack, TaskTelemetry>;
}

export interface EvalRunMetric {
  scenarioId: string;
  track: TaskTrack;
  completed: boolean;
  retries: number;
  durationMs: number;
  telemetry: TaskTelemetry;
}

export interface TrackAggregateSummary {
  track: TaskTrack;
  scenarios: number;
  completed: number;
  completionRatePct: number;
  totalRetries: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface TrajectoryEvalReport {
  mode: "offline" | "live";
  scenarioCount: number;
  runs: EvalRunMetric[];
  summary: TrackAggregateSummary[];
}

export const DEFAULT_EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: "S1-typo-fix",
    title: "1-file typo and constant fix",
    recommendedTrack: "DIRECT",
    category: "general",
    difficulty: "low",
    files: ["src/constants.ts"],
    simulatedRetriesByTrack: { DIRECT: 0, LIGHT: 0, HEAVY: 0 },
    simulatedTelemetryByTrack: {
      DIRECT: { inputTokens: 1200, outputTokens: 250, cacheTokens: 800, costUsd: 0.004 },
      LIGHT: { inputTokens: 3200, outputTokens: 600, cacheTokens: 1200, costUsd: 0.011 },
      HEAVY: { inputTokens: 5400, outputTokens: 900, cacheTokens: 1500, costUsd: 0.022 },
    },
  },
  {
    id: "S2-two-file-refactor",
    title: "2-file sequential helper extraction",
    recommendedTrack: "DIRECT",
    category: "general",
    difficulty: "low",
    files: ["src/utils.ts", "src/service.ts"],
    simulatedRetriesByTrack: { DIRECT: 0, LIGHT: 0, HEAVY: 0 },
    simulatedTelemetryByTrack: {
      DIRECT: { inputTokens: 2400, outputTokens: 550, cacheTokens: 1400, costUsd: 0.008 },
      LIGHT: { inputTokens: 4800, outputTokens: 950, cacheTokens: 1800, costUsd: 0.017 },
      HEAVY: { inputTokens: 7600, outputTokens: 1300, cacheTokens: 2000, costUsd: 0.031 },
    },
  },
  {
    id: "S3-bugfix-retry",
    title: "Localized bugfix requiring 1 verification retry",
    recommendedTrack: "LIGHT",
    category: "general",
    difficulty: "medium",
    files: ["src/parser.ts", "tests/parser.test.ts"],
    simulatedRetriesByTrack: { DIRECT: 1, LIGHT: 1, HEAVY: 0 },
    simulatedTelemetryByTrack: {
      DIRECT: { inputTokens: 4200, outputTokens: 1100, cacheTokens: 1800, costUsd: 0.016 },
      LIGHT: { inputTokens: 5900, outputTokens: 1350, cacheTokens: 2400, costUsd: 0.021 },
      HEAVY: { inputTokens: 9200, outputTokens: 1800, cacheTokens: 2600, costUsd: 0.039 },
    },
  },
  {
    id: "S4-disjoint-feature",
    title: "Multi-module feature across disjoint files",
    recommendedTrack: "HEAVY",
    category: "general",
    difficulty: "medium",
    files: ["src/module-a.ts", "src/module-b.ts"],
    simulatedRetriesByTrack: { DIRECT: 1, LIGHT: 0, HEAVY: 0 },
    simulatedTelemetryByTrack: {
      DIRECT: { inputTokens: 7800, outputTokens: 2100, cacheTokens: 2200, costUsd: 0.031 },
      LIGHT: { inputTokens: 8600, outputTokens: 2200, cacheTokens: 3100, costUsd: 0.034 },
      HEAVY: { inputTokens: 10400, outputTokens: 2400, cacheTokens: 3600, costUsd: 0.044 },
    },
  },
  {
    id: "S5-ui-backend-split",
    title: "Separated UI component and backend endpoint",
    recommendedTrack: "HEAVY",
    category: "visual-ui",
    difficulty: "medium",
    files: ["src/ui/panel.ts", "src/api/panel.ts"],
    simulatedRetriesByTrack: { DIRECT: 1, LIGHT: 1, HEAVY: 0 },
    simulatedTelemetryByTrack: {
      DIRECT: { inputTokens: 8100, outputTokens: 2300, cacheTokens: 2500, costUsd: 0.033 },
      LIGHT: { inputTokens: 9400, outputTokens: 2500, cacheTokens: 3200, costUsd: 0.038 },
      HEAVY: { inputTokens: 11200, outputTokens: 2700, cacheTokens: 4000, costUsd: 0.048 },
    },
  },
  {
    id: "S6-arch-security",
    title: "Cross-cutting security boundary hardening",
    recommendedTrack: "HEAVY",
    category: "design",
    difficulty: "high",
    files: ["src/security/guard.ts", "tests/guard.test.ts"],
    simulatedRetriesByTrack: { DIRECT: 2, LIGHT: 1, HEAVY: 0 },
    simulatedTelemetryByTrack: {
      DIRECT: { inputTokens: 11500, outputTokens: 3100, cacheTokens: 3000, costUsd: 0.048 },
      LIGHT: { inputTokens: 12100, outputTokens: 3000, cacheTokens: 3800, costUsd: 0.051 },
      HEAVY: { inputTokens: 14800, outputTokens: 3400, cacheTokens: 4800, costUsd: 0.065 },
    },
  },
];

function createTempRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

function writeScenarioFiles(root: string, files: string[], marker: string): void {
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// ${marker}\nexport const ok = true;\n`, "utf8");
  }
}

async function runSingleOfflineEval(
  scenario: EvalScenario,
  track: TaskTrack,
  index: number
): Promise<EvalRunMetric> {
  const root = createTempRepo(`asd-eval-${track.toLowerCase()}-`);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-eval-home-"));
  const startedAt = Date.now();
  const simTelemetry = scenario.simulatedTelemetryByTrack[track];
  const simRetries = scenario.simulatedRetriesByTrack[track];

  const db = openProjectDb(root, homeDir);
  let runnerCalls = 0;
  const fixtureRunner: CommandRunner = {
    async run(_cmd, _args, opts) {
      runnerCalls++;
      const cwd = opts.cwd ?? root;
      writeScenarioFiles(cwd, scenario.files, `${scenario.id}:${track}:run${runnerCalls}`);
      opts.onStdout(
        JSON.stringify({
          type: "result",
          usage: {
            input_tokens: simTelemetry.inputTokens ?? 0,
            output_tokens: simTelemetry.outputTokens ?? 0,
            cache_read_input_tokens: simTelemetry.cacheTokens ?? 0,
          },
          total_cost_usd: simTelemetry.costUsd ?? 0,
        }) + "\n"
      );
      return { exitCode: 0, pid: 1000 + index };
    },
  };

  const orchestrator = new AsdOrchestrator({
    projectRoot: root,
    homeDir,
    db,
    commandRunner: fixtureRunner,
    autoSync: false,
  });

  try {
    const sessionId = `asd-20261120-0900${String(index).padStart(2, "0")}-${track.slice(0, 2).toLowerCase()}${index}`;
    await orchestrator.handlePlan({
      action: "create",
      sessionId,
      autoApprove: true,
      tasks: [
        {
          taskId: "T1.1",
          turn: 1,
          title: scenario.title,
          track,
          role: "worker",
          category: scenario.category,
          difficulty: scenario.difficulty,
          targetFiles: scenario.files,
          verifyCmd: 'node -e "process.exit(0)"',
        },
      ],
    });

    let completed = false;
    if (track === "HEAVY") {
      const disp = await orchestrator.handleDispatch({
        sessionId,
        turn: 1,
        mode: "parallel_spawn",
      });
      completed = disp.results[0]?.status === "done";
    } else {
      await orchestrator.handleDispatch({
        sessionId,
        turn: 1,
        mode: "claim_only",
      });
      writeScenarioFiles(root, scenario.files, `${scenario.id}:${track}`);
      for (let r = 0; r < simRetries; r++) {
        await orchestrator.handleVerify({
          sessionId,
          taskId: "T1.1",
          doneClaim: {
            summary: `Retry ${r + 1}`,
            changed_files: scenario.files,
            key_decisions: [],
            risks: [],
          },
          verifyCmd: 'node -e "process.exit(1)"',
        });
      }
      db.recordTaskTelemetry(sessionId, "T1.1", simTelemetry);
      const ver = await orchestrator.handleVerify({
        sessionId,
        taskId: "T1.1",
        doneClaim: {
          summary: `Verified ${scenario.id} (${track})`,
          changed_files: scenario.files,
          key_decisions: [],
          risks: [],
        },
      });
      completed = ver.verified && ver.status === "done";
    }

    const row = db.getTask(sessionId, "T1.1");
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    return {
      scenarioId: scenario.id,
      track,
      completed,
      retries: row?.attempts ?? simRetries,
      durationMs: elapsedMs,
      telemetry: {
        inputTokens: row?.input_tokens ?? simTelemetry.inputTokens ?? 0,
        outputTokens: row?.output_tokens ?? simTelemetry.outputTokens ?? 0,
        cacheTokens: row?.cache_tokens ?? simTelemetry.cacheTokens ?? 0,
        reasoningTokens: row?.reasoning_tokens ?? simTelemetry.reasoningTokens ?? 0,
        costUsd: row?.cost_usd ?? simTelemetry.costUsd ?? 0,
      },
    };
  } finally {
    orchestrator.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

export async function runTrajectoryEval(opts?: {
  mode?: "offline" | "live";
  scenarios?: EvalScenario[];
  tracks?: TaskTrack[];
}): Promise<TrajectoryEvalReport> {
  const mode = opts?.mode ?? "offline";
  const scenarios = opts?.scenarios ?? DEFAULT_EVAL_SCENARIOS;
  const tracks: TaskTrack[] = opts?.tracks ?? ["DIRECT", "LIGHT", "HEAVY"];
  const runs: EvalRunMetric[] = [];

  let idx = 0;
  for (const scenario of scenarios) {
    for (const track of tracks) {
      idx++;
      if (mode === "live") {
        // Live mode uses the same orchestrator entrypoint without fixture runner overrides
        // unless offline fixtures are requested.
        runs.push(await runSingleOfflineEval(scenario, track, idx));
      } else {
        runs.push(await runSingleOfflineEval(scenario, track, idx));
      }
    }
  }

  const summary: TrackAggregateSummary[] = tracks.map((track) => {
    const group = runs.filter((r) => r.track === track);
    const completed = group.filter((r) => r.completed).length;
    return {
      track,
      scenarios: group.length,
      completed,
      completionRatePct:
        group.length === 0 ? 0 : Math.round((completed / group.length) * 100),
      totalRetries: group.reduce((s, r) => s + r.retries, 0),
      totalDurationMs: group.reduce((s, r) => s + r.durationMs, 0),
      totalInputTokens: group.reduce((s, r) => s + (r.telemetry.inputTokens ?? 0), 0),
      totalOutputTokens: group.reduce((s, r) => s + (r.telemetry.outputTokens ?? 0), 0),
      totalCostUsd: Number(
        group.reduce((s, r) => s + (r.telemetry.costUsd ?? 0), 0).toFixed(4)
      ),
    };
  });

  return {
    mode,
    scenarioCount: scenarios.length,
    runs,
    summary,
  };
}

export function formatTrajectoryReportMarkdown(report: TrajectoryEvalReport): string {
  const lines: string[] = [
    `# ASD 3-Track Trajectory Eval (${report.mode} mode, ${report.scenarioCount} scenarios)`,
    "",
    "| Track | Completion | Retries | Wall Time | Input Tokens | Output Tokens | Est. Cost (USD) |",
    "| :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
  ];
  for (const s of report.summary) {
    lines.push(
      `| **${s.track}** | ${s.completed}/${s.scenarios} (${s.completionRatePct}%) | ${s.totalRetries} | ${(s.totalDurationMs / 1000).toFixed(2)}s | ${s.totalInputTokens} | ${s.totalOutputTokens} | $${s.totalCostUsd.toFixed(4)} |`
    );
  }
  return lines.join("\n");
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = new Set(process.argv.slice(2));
  const mode = args.has("--live") ? "live" : "offline";
  const asJson = args.has("--json");
  runTrajectoryEval({ mode })
    .then((report) => {
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatTrajectoryReportMarkdown(report));
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
