import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Reusable browser tooling is JavaScript.
import { checkExpectedMeasurements } from "../scripts/authoring-rule-oracles.mjs";

test("independent coordinate oracle rejects empty, missing, duplicate and wrong measurements", () => {
  const expected = [{ ruleId: "x", time: 1, measured: [24], tolerance: 0.001 }];
  const result = { id: "x", time: 1, status: "pass", measured: [24.0001] };
  assert.equal(checkExpectedMeasurements({ results: [result] }, expected).failed, false);
  assert.equal(checkExpectedMeasurements({ results: [] }, expected).failed, true);
  assert.equal(checkExpectedMeasurements({ results: [result, result] }, expected).failed, true);
  assert.equal(checkExpectedMeasurements({ results: [{ ...result, measured: [25] }] }, expected).failed, true);
  assert.equal(checkExpectedMeasurements({ results: [{ ...result, status: "indeterminate" }] }, expected).failed, true);
  assert.throws(() => checkExpectedMeasurements({ results: [] }, []), /empty/);
});
