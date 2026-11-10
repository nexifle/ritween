/**
 * Environment-identity reproducibility check for the G0/G7 baseline
 * (docs/plans/declarative-layout-hardening.md §13.4: "If either batch cannot be
 * reproduced under the recorded environment, repair the benchmark environment").
 *
 * This compares the environment identity each independently launched page
 * recorded: browser version, adapter, user agent, font face hashes and raster
 * probe. It proves the runs shared one environment; it does NOT prove the frozen
 * snapshot can be replayed, which scripts/layout-baseline-replay.mjs measures
 * separately. Any drift (including a field a run failed to record) is returned
 * as a reason; an empty list is the only evidence that counts.
 */

/** Fields a run must actually record; compared by value, never assumed present. */
const IDENTITY_FIELDS = [
  "browserVersion",
  "userAgent",
  "adapter",
  "fontFaces",
  "rasterProof",
];

/** Reason a recorded identity field is unusable, or undefined when it is usable. */
function missingFieldReason(key, value) {
  if (value === undefined || value === null)
    return `${key} was not recorded; comparing it across runs proves nothing`;
  if (typeof value === "string" && !value.trim()) return `${key} is empty`;
  return undefined;
}

/**
 * The per-run environment record the driver stores. The driver calls this, so the
 * test that asserts `browserVersion` is present cannot drift from the driver:
 * before this existed, the driver omitted the field while the check compared it.
 */
export function recordRunEnvironment({ browserVersion, userAgent, adapter }) {
  return { browserVersion, userAgent, adapter };
}

export function environmentIdentity(run) {
  const proof = run.result.fontProof;
  return {
    browserVersion: run.environment.browserVersion,
    userAgent: run.environment.userAgent,
    adapter: run.environment.adapter,
    fontFaces: proof.faces.map((face) => ({
      weight: face.weight,
      sha256: face.sha256,
      sha256MatchesFixture: face.sha256MatchesFixture,
    })),
    rasterProof: proof.rasterProof,
  };
}

/** Human-readable reasons the runs did not share one environment; [] = reproduced. */
export function findEnvironmentDrift(runs) {
  if (!runs.length) return ["no runs recorded"];
  const drift = [];
  const identities = runs.map((run) => ({
    label: `batch${run.batch} ${run.fixture} run${run.run}`,
    identity: environmentIdentity(run),
  }));
  for (const key of IDENTITY_FIELDS) {
    // A field no run recorded can never be compared, so it is reported once
    // rather than as N identical drifts.
    const recorded = identities.filter(
      ({ identity }) => !missingFieldReason(key, identity[key]),
    );
    if (!recorded.length) {
      drift.push(
        `${key} was not recorded by any run; comparing it proves nothing`,
      );
      continue;
    }
    for (const { label, identity } of identities) {
      const reason = missingFieldReason(key, identity[key]);
      if (reason) drift.push(`${label}: ${reason}`);
    }
    const reference = recorded[0].identity[key];
    for (const { label, identity } of recorded) {
      const reason = missingFieldReason(key, identity[key]);
      if (reason) continue;
      if (JSON.stringify(reference) !== JSON.stringify(identity[key]))
        drift.push(
          `${label}: ${key} differs (${JSON.stringify(reference)} != ${JSON.stringify(identity[key])})`,
        );
    }
  }
  for (const run of runs) {
    const label = `batch${run.batch} ${run.fixture} run${run.run}`;
    for (const face of run.result.fontProof.faces)
      if (!face.sha256MatchesFixture)
        drift.push(
          `${label}: font ${face.file} hash does not match the committed fixture`,
        );
    if (run.errors.length) drift.push(`${label}: ${run.errors.join("; ")}`);
  }
  return drift;
}
