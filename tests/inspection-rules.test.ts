import { test } from "node:test";
import assert from "node:assert/strict";
import { Box, SafeArea, evaluateView } from "../src/authoring/index";
import {
  parseRules,
  evaluateRules,
  summarizeRuleSchedule,
  type InspectionRule,
} from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";
const target = (id: string) => ({
  scope: "scene:a",
  id,
  space: "layout",
  bounds: "layout-slot" as const,
});
const rule: InspectionRule = {
  id: "gap",
  kind: "minimum-gap",
  a: target("a"),
  b: target("b"),
  axis: "x",
  minimum: 10,
  space: "scene:a/layout",
};
function document(time = 0): InspectionDocument {
  const node = (id: string, x: number) => ({
    id,
    path: id,
    kind: "box",
    bounds: { x, y: 0, width: 10, height: 10 },
    allocatedSlot: { x, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children: [],
  });
  return {
    time: { effective: time, requested: time },
    scenes: [
      {
        scope: "scene:a",
        tree: { ...node("root", 0), children: [node("a", 0), node("b", 20)] },
      },
    ],
  } as unknown as InspectionDocument;
}
const run = (r: InspectionRule = rule, doc = document()) =>
  evaluateRules(doc, { schemaVersion: 1, rules: [r] })[0];
test("signed gaps, explicit spaces, missing targets and temporal inactivity", () => {
  assert.equal(run().status, "pass");
  assert.equal(run({ ...rule, minimum: 11 }).status, "fail");
  assert.equal(run({ ...rule, a: rule.b, b: rule.a }).status, "fail");
  assert.equal(run({ ...rule, space: "other" }).status, "indeterminate");
  assert.equal(run({ ...rule, a: target("missing") }).status, "fail");
  assert.equal(
    run({ ...rule, temporal: { start: 1, end: 2, samples: [1] } }).status,
    "not-applicable",
  );
});
test("exact rectangle rules, edge touching, tolerance and containment", () => {
  assert.equal(run({ ...rule, kind: "non-overlap" }).status, "pass");
  assert.equal(
    run({ ...rule, kind: "alignment", axis: "y", align: "center" }).status,
    "pass",
  );
  assert.equal(
    run({ ...rule, kind: "containment", a: rule.a, b: rule.a }).status,
    "pass",
  );
  assert.equal(
    run({
      ...rule,
      kind: "minimum-inset",
      edge: "left",
      a: rule.a,
      b: rule.a,
      minimum: 1,
    }).status,
    "fail",
  );
  assert.equal(run({ ...rule, minimum: 10.005 }).status, "pass");
});
test("strict schema, limits and schedules reject malformed inputs", () => {
  const json = (r: unknown) => JSON.stringify({ schemaVersion: 1, rules: [r] });
  assert.deepEqual(parseRules(json(rule)).rules[0], rule);
  for (const r of [
    { ...rule, tolerance: -1 },
    { ...rule, typo: 1 },
    { ...rule, a: { ...rule.a, path: "x" } },
    { ...rule, temporal: { start: 1, end: 2, samples: [1.5, 1] } },
  ])
    assert.throws(() => parseRules(json(r)));
  assert.throws(() => parseRules(" ".repeat(1024 * 1024 + 1)));
  assert.throws(() =>
    parseRules(
      JSON.stringify({ schemaVersion: 1, rules: Array(10001).fill(rule) }),
    ),
  );
  const file = {
    schemaVersion: 1 as const,
    rules: [{ ...rule, temporal: { start: 0, end: 2, samples: [0, 1] } }],
  };
  assert.equal(summarizeRuleSchedule(file, [run()])[0].coverageFailure, true);
  assert.equal(
    summarizeRuleSchedule(file, [
      run(rule, document(0)),
      run(rule, document(1)),
    ])[0].coverageFailure,
    false,
  );
});
test("SafeArea occupies proposal, offsets content, exposes local rectangle and never clips", () => {
  const insets = { left: 10, right: 20, top: 30, bottom: 40 };
  const root = SafeArea(
    Box({ width: 200, height: 10 }).id("content"),
    insets,
  ).id("safe");
  insets.left = 99;
  const frame = evaluateView(root, {
    width: 100,
    height: 100,
    time: 0,
    inspection: true,
    measureText: () => 0,
  });
  assert.deepEqual(frame.tree.bounds, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(frame.tree.safeBounds, {
    x: 10,
    y: 30,
    width: 70,
    height: 30,
  });
  assert.equal(frame.commands.length, 1);
  assert.equal(frame.commands[0].bounds.x, 10);
  assert.equal(frame.commands[0].bounds.width, 200);
  assert.throws(() => SafeArea(root, { top: NaN }));
  assert.throws(() =>
    evaluateView(SafeArea(root, { left: 101 }), {
      width: 100,
      height: 100,
      time: 0,
      measureText: () => 0,
    }),
  );
});
