import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRules,
  parseRules,
  type InspectionRule,
} from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";
const target = (id: string) => ({
  scope: "scene:a",
  space: "layout",
  id,
  bounds: "projected-paint" as const,
});
const rect = (x: number, width = 10) => ({ x, y: 0, width, height: 10 });
function fixture(accuracy = "exact-rectangle", extra = false) {
  const paint = (nodeId: number, x: number, paintRole = "content") => ({
    inspection: { nodeId },
    paintRole,
    accuracy,
    geometryVisible: true,
    sceneWeight: 1,
    bounds: rect(x),
    provenance: "projected-box-draw-quad",
  });
  return {
    time: { effective: 0 },
    scenes: [
      {
        scope: "scene:a",
        tree: {
          path: "root",
          children: [
            { id: "a", inspectionId: 1, path: "a", children: [] },
            { id: "b", inspectionId: 2, path: "b", children: [] },
          ],
        },
        finalPaintRecords: [
          paint(1, 0),
          ...(extra ? [paint(1, 40)] : []),
          paint(1, -20, "background"),
          paint(2, 20),
        ],
      },
    ],
  } as unknown as InspectionDocument;
}
const rule: InspectionRule = {
  id: "pair",
  kind: "non-overlap",
  a: target("a"),
  b: target("b"),
  space: "output-pixels",
  assertionDomain: "ideal-projected-bounds",
};
const run = (r = rule, doc = fixture()) =>
  evaluateRules(doc, { schemaVersion: 1, rules: [r] })[0];
test("hollow aggregates do not collide merely because envelopes intersect", () => {
  assert.equal(run(rule, fixture("exact-rectangle", true)).status, "pass");
  assert.equal(
    run(
      { ...rule, kind: "containment", a: rule.b, b: rule.a },
      fixture("exact-rectangle", true),
    ).status,
    "indeterminate",
  );
});
test("conservative separation passes but possible collision and container remain indeterminate", () => {
  assert.equal(run(rule, fixture("conservative")).status, "pass");
  assert.equal(
    run({ ...rule, b: rule.a }, fixture("conservative")).status,
    "indeterminate",
  );
  assert.equal(
    run({ ...rule, kind: "containment", b: rule.a }, fixture("conservative"))
      .status,
    "indeterminate",
  );
  assert.equal(
    run(
      { ...rule, kind: "alignment", axis: "x", align: "start" },
      fixture("conservative"),
    ).status,
    "fail",
  );
});
test("background is opt-in and minimum inset measures signed distance", () => {
  const result = run({
    ...rule,
    kind: "minimum-inset",
    edge: "left",
    minimum: 20,
    b: { ...rule.a, paintSelection: "background" },
  });
  assert.equal(result.status, "pass");
  assert.deepEqual(result.measured, [20]);
  assert.equal(
    run({ ...rule, assertionDomain: "pixel-contribution" }).status,
    "indeterminate",
  );
});
test("strict explicit domain, immutable parsed schema and endpoint/missing semantics", () => {
  assert.throws(() =>
    parseRules(
      JSON.stringify({
        schemaVersion: 1,
        rules: [{ ...rule, assertionDomain: undefined }],
      }),
    ),
  );
  const parsed = parseRules(
    JSON.stringify({ schemaVersion: 1, rules: [rule] }),
  );
  assert.ok(Object.isFrozen(parsed.rules[0].a));
  const temporal = { start: 0, end: 1, samples: [0], includeEnd: false };
  const doc = fixture();
  const endpoint = { ...doc, time: { requested: 1, effective: 1 } };
  assert.equal(run({ ...rule, temporal }, endpoint).status, "not-applicable");
  assert.equal(
    run(
      {
        ...rule,
        temporal: { ...temporal, includeEnd: true },
        a: target("missing"),
      },
      endpoint,
    ).status,
    "fail",
  );
});
