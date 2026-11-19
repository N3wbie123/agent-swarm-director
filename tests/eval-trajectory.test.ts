/**
 * Tests for the lightweight 3-Track Trajectory Eval Suite
 * (`tests/eval-trajectory.test.ts`).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_EVAL_SCENARIOS,
  formatTrajectoryReportMarkdown,
  runTrajectoryEval,
} from "../scripts/eval-trajectory.ts";

describe("3-Track Trajectory Eval Suite (DIRECT vs LIGHT vs HEAVY)", () => {
  test("runs offline deterministic scenarios across all 3 tracks and aggregates metrics", async () => {
    const sampleScenarios = DEFAULT_EVAL_SCENARIOS.slice(0, 2);
    const report = await runTrajectoryEval({
      mode: "offline",
      scenarios: sampleScenarios,
    });

    assert.equal(report.mode, "offline");
    assert.equal(report.scenarioCount, 2);
    assert.equal(report.runs.length, 6);
    assert.equal(report.summary.length, 3);

    for (const trackSummary of report.summary) {
      assert.equal(trackSummary.scenarios, 2);
      assert.equal(trackSummary.completed, 2);
      assert.equal(trackSummary.completionRatePct, 100);
      assert.ok(trackSummary.totalInputTokens > 0);
      assert.ok(trackSummary.totalOutputTokens > 0);
      assert.ok(trackSummary.totalCostUsd > 0);
      assert.ok(trackSummary.totalDurationMs > 0);
    }

    // DIRECT uses lower token/cost footprint than HEAVY on small tasks
    const direct = report.summary.find((s) => s.track === "DIRECT")!;
    const heavy = report.summary.find((s) => s.track === "HEAVY")!;
    assert.ok(direct.totalCostUsd < heavy.totalCostUsd);

    const md = formatTrajectoryReportMarkdown(report);
    assert.ok(md.includes("| **DIRECT** |"));
    assert.ok(md.includes("| **LIGHT** |"));
    assert.ok(md.includes("| **HEAVY** |"));
  });

  test("DEFAULT_EVAL_SCENARIOS provides 6 representative scenarios covering all 3 tracks", () => {
    assert.equal(DEFAULT_EVAL_SCENARIOS.length, 6);
    const recommended = new Set(DEFAULT_EVAL_SCENARIOS.map((s) => s.recommendedTrack));
    assert.equal(recommended.has("DIRECT"), true);
    assert.equal(recommended.has("LIGHT"), true);
    assert.equal(recommended.has("HEAVY"), true);
  });
});
