/**
 * Falsifiable reproducibility check for the G0/G7 baseline
 * (docs/plans/declarative-layout-hardening.md §13.4). This replaces an earlier
 * tautology that compared |a-b| against a bound containing 2|a-b|, which is
 * always true for finite numbers and therefore proved nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  environmentIdentity,
  findEnvironmentDrift,
  recordRunEnvironment,
} from "../scripts/layout-baseline-reproducibility.mjs";

/**
 * Shaped exactly like the object scripts/layout-baseline-run.mjs stores per run,
 * built through the same recordRunEnvironment() the driver calls. A synthetic
 * fixture that added fields the driver never records is what let the missing
 * browserVersion pass review before.
 */
function run({
  browserVersion = "Chrome/155",
  userAgent = "UA",
  adapter,
  ...overrides
} = {}) {
  return {
    batch: 1,
    fixture: "regression",
    run: 1,
    environment: recordRunEnvironment({
      browserVersion,
      userAgent,
      adapter: adapter ?? { vendor: "apple", architecture: "metal-3" },
    }),
    result: {
      fontProof: {
        faces: [
          {
            file: "Inter-Regular.woff2",
            weight: "400",
            sha256: "a",
            sha256MatchesFixture: true,
          },
          {
            file: "Inter-Bold.woff2",
            weight: "700",
            sha256: "b",
            sha256MatchesFixture: true,
          },
        ],
        rasterProof: {
          probe: "Ritween baseline 123",
          width400: 1,
          width700: 2,
          fallbackWidth: 3,
        },
      },
    },
    errors: [],
    ...overrides,
  };
}

test("identical environments produce no drift", () => {
  assert.deepEqual(findEnvironmentDrift([run(), run({ batch: 2 })]), []);
});

test("a changed browser, adapter, font hash, raster probe or page error is drift", () => {
  const variants = {
    browser: run({ browserVersion: "Chrome/154" }),
    adapter: run({ adapter: { vendor: "apple", architecture: "metal-2" } }),
    pageError: run({ errors: ["GPU: validation failed"] }),
  };
  for (const [label, drifted] of Object.entries(variants))
    assert.notDeepEqual(findEnvironmentDrift([run(), drifted]), [], label);

  const badHash = run();
  badHash.result.fontProof.faces[1].sha256 = "c";
  assert.match(
    findEnvironmentDrift([run(), badHash]).join(" "),
    /fontFaces differs/,
  );

  const badRaster = run();
  badRaster.result.fontProof.rasterProof = {
    probe: "p",
    width400: 1,
    width700: 1,
    fallbackWidth: 3,
  };
  assert.match(
    findEnvironmentDrift([run(), badRaster]).join(" "),
    /rasterProof differs/,
  );
});

test("a mismatched committed font hash is drift even when all runs agree", () => {
  const unverified = run();
  unverified.result.fontProof.faces[0].sha256MatchesFixture = false;
  assert.match(
    findEnvironmentDrift([unverified, run({ batch: 2 })]).join(" "),
    /font Inter-Regular\.woff2 hash does not match/,
  );
});

test("a run that never recorded browserVersion is drift, not a silent pass", () => {
  // The exact regression the driver had: the field was compared but not recorded.
  const missing = run();
  delete missing.environment.browserVersion;
  const drift = findEnvironmentDrift([missing, run({ batch: 2 })]);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /browserVersion was not recorded/);
});

test("an empty or null recorded field is drift too", () => {
  // undefined is covered by the missing-field test above; the default parameter
  // would otherwise substitute a value here.
  for (const value of ["", "   ", null]) {
    const broken = run({ browserVersion: value });
    assert.match(
      findEnvironmentDrift([broken, run({ batch: 2 })]).join(" "),
      /browserVersion (is empty|was not recorded)/,
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("no runs is not evidence of reproduction", () => {
  assert.deepEqual(findEnvironmentDrift([]), ["no runs recorded"]);
});

test("identity exposes exactly the compared fields", () => {
  const identity = environmentIdentity(run());
  assert.deepEqual(Object.keys(identity), [
    "browserVersion",
    "userAgent",
    "adapter",
    "fontFaces",
    "rasterProof",
  ]);
  assert.equal(identity.fontFaces[0].weight, "400");
});
