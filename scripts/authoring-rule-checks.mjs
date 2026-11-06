/** Reusable authored schedule runner. The caller owns one browser/renderer session. */
export async function validateRuleSchedule({
  rules,
  inspect,
  evaluateRules,
  summarizeRuleSchedule,
}) {
  const times = [
    ...new Set(rules.rules.flatMap((rule) => rule.temporal?.samples ?? [])),
  ].sort((a, b) => a - b);
  const results = [];
  for (const time of times) {
    // Each temporal rule owns its samples. Another rule's sample must not silently
    // add checks to that schedule (for example during an intentional entrance).
    const scheduled = {
      ...rules,
      rules: rules.rules.filter((rule) =>
        rule.temporal ? rule.temporal.samples.includes(time) : true,
      ),
    };
    results.push(...evaluateRules(await inspect(time), scheduled));
  }
  const summary = summarizeRuleSchedule(rules, results);
  return {
    times,
    results,
    summary,
    failed: summary.some((rule) => rule.coverageFailure || rule.failed),
  };
}
