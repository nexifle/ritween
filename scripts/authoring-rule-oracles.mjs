/** Compare authored numeric expectations with measured rule outputs, never transforms. */
export function checkExpectedMeasurements(report, expectations) {
  if (!Array.isArray(expectations) || expectations.length === 0)
    throw Error("Expected-coordinate coverage must not be empty.");
  const checks = expectations.map(({ ruleId, time, measured, status = "pass", tolerance = 0.0001 }) => {
    if (!Number.isFinite(tolerance) || tolerance < 0 || !measured?.length || !measured.every(Number.isFinite))
      throw Error("Invalid numeric oracle.");
    const matches = report.results.filter((r) => r.id === ruleId && r.time === time);
    const actual = matches.length === 1 ? matches[0].measured : undefined;
    const differences = actual?.map((v, i) => v - measured[i]);
    const pass = matches.length === 1 && matches[0].status === status && actual?.length === measured.length && differences.every((v) => Number.isFinite(v) && Math.abs(v) <= tolerance);
    return { ruleId, time, expected: measured, expectedStatus: status, actualStatus: matches[0]?.status, actual, differences, tolerance, pass };
  });
  return { checks, failed: checks.some((c) => !c.pass) };
}
