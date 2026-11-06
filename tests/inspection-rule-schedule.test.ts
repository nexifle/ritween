import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRuleSchedule, type RulesFile } from "../src/engine/inspect/rules";

test("empty authored samples remain a coverage failure despite incidental results", () => {
  const file = { rules: [{ id: "empty", temporal: { samples: [] } }] } as unknown as RulesFile;
  const summary = summarizeRuleSchedule(file, [{ id: "empty", time: 1, status: "pass" }] as any);
  assert.equal(summary[0].coverageFailure, true);
});

test("schedule runner executes only each temporal rule's own samples", async () => {
  // Reusable browser tooling is JavaScript, shared with the command-line runner.
  // @ts-expect-error Tooling module intentionally has no declaration file.
  const { validateRuleSchedule } = await import("../scripts/authoring-rule-checks.mjs");
  const calls: unknown[] = [];
  const report = await validateRuleSchedule({
    rules: { rules: [
      { id: "entrance", temporal: { samples: [0] } },
      { id: "settled", temporal: { samples: [1] } },
    ] },
    inspect: async (time: number) => time,
    evaluateRules: (time: number, file: any) => {
      calls.push([time, file.rules.map((r: any) => r.id)]);
      return [];
    },
    summarizeRuleSchedule: () => [],
  });
  assert.deepEqual(calls, [[0, ["entrance"]], [1, ["settled"]]]);
  assert.deepEqual(report.times, [0, 1]);
});
