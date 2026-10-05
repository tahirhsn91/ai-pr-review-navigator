import type { Evaluation } from "./measure.js";
import { estimateCostUsd } from "./measure.js";

export function renderReport(evaluation: Evaluation): string {
  const lines = [
    "# End-to-end evaluation",
    "",
    "This report measures one synthetic pull request.",
    "It does not claim the product is ready to roll out.",
    "",
    "## Dataset",
    "",
    `- Files: ${evaluation.files}`,
    `- Labeled regions: ${evaluation.labels}`,
    `- Important regions: ${evaluation.important}`,
    `- Not-important regions: ${evaluation.notImportant}`,
    `- Uncertain regions: ${evaluation.uncertain}`,
    `- Historical pull requests: ${evaluation.historicalPullRequests}`,
    "",
    "Labels mean a block deserves human review.",
    "They are not labels for known bugs.",
    "One author assigned them on synthetic fixtures.",
    "No second rater and no historical reviewer labels were used.",
    "Private pull requests were not fetched.",
    "",
    "## Model",
    "",
    "The stand-in returns a fixed JSON card when the prompt contains a snippet.",
    "Unmatched blocks stay uncertain.",
    "Cards were written from the fixture text, not from the gold label.",
    "This is not a call to Claude or GPT.",
    "Cost uses the rates in src/llm/limits.ts: 3 USD and 15 USD per million tokens.",
    "That cost is an estimate, not an invoice.",
    "",
    "## Metrics",
    "",
    ...metricLines(evaluation),
    "",
    "Recall counts must-review and review-if-relevant coverage.",
    "needs-context is not a recall hit and is not a silent drop.",
    "Top-five uses the first five displayed blocks, not the whole comment.",
    "Precision divides important overlaps by every selected review block.",
    "Unlabeled and uncertain-only blocks count against precision.",
    "A changed-range link is accurate when every linked line was really changed.",
    "Wider inline context links are checked only to see that the file line exists.",
    "Wall-clock latency is asserted by the test and is not frozen here.",
    "",
    "## Label placements",
    "",
    ...evaluation.outcomes.map(
      (outcome) => `- ${outcome.id}: ${outcome.role}, ${outcome.category}, ${outcome.placement}`,
    ),
    "",
    "## Selected blocks without an important or not-important label",
    "",
    ...(evaluation.unlabeledSelected.length === 0
      ? ["- None."]
      : evaluation.unlabeledSelected.map(
          (block) => `- ${block.path} ${block.group} ${block.blockId}`,
        )),
    "",
    "## Failure scenarios",
    "",
    ...evaluation.failures.map((failure) => `- ${failure.id}: ${failure.observed}`),
    "",
    "## Security",
    "",
    ...evaluation.security.map((item) => `- ${item.id}: ${item.observed}`),
    "",
    "## Limitations",
    "",
    "- The dataset is small and synthetic.",
    "- A handful of agreements is not evidence of production quality.",
    "- The stand-in can agree with the author because both read the same fixture.",
    "- Reviewer time saved was not measured.",
    "- Missing patch text is anchored to the whole file, so its line range is wrong.",
    "- A file with no patch and no source is still excluded, because it has no line.",
    "- The stale-head check runs only when PUBLISH_HEAD_SHA is set.",
    "- The product does not poll GitHub for a newer head SHA.",
    "- Metrics were not adjusted to improve these figures.",
    "",
    "## Pilot readiness",
    "",
    "Pilot readiness: Not ready.",
    "",
    "Important-block recall was measured on this fixture before any rollout claim.",
    "The measurement is not a passing score for a pilot.",
    "Reviewer-reported time saved: not measured.",
    "",
  ];
  return `${lines.join("\n")}`;
}

export function metricLines(evaluation: Evaluation): string[] {
  return [
    `- Important-block recall: ${ratio(evaluation.recallHits, evaluation.important)}`,
    `- Top-five coverage: ${ratio(evaluation.topFiveHits, evaluation.important)}`,
    `- Selected-block precision: ${ratio(evaluation.precisionHits, evaluation.precisionDenom)}`,
    `- Not-important regions deprioritized: ${ratio(evaluation.deprioritizedSafe, evaluation.notImportant)}`,
    `- Important regions deprioritized: ${ratio(evaluation.importantMisses, evaluation.important)}`,
    `- Uncertain regions silently deprioritized: ${ratio(evaluation.uncertainSilent, evaluation.uncertain)}`,
    `- Links checked: ${evaluation.linksChecked}. Unresolved links: ${evaluation.linkResolveFailures}.`,
    `- Changed-range links: ${evaluation.rangeChecks}. Inaccurate: ${evaluation.rangeMisses}.`,
    `- Inaccurate changed-range paths: ${evaluation.rangeMissPaths.join(", ") || "none"}.`,
    `- Duplicate summary comments after ${evaluation.publishAttempts} publishes: ${evaluation.summaryExtras}.`,
    `- Duplicate inline comments: ${evaluation.inlineExtras}.`,
    `- Stand-in tokens: ${evaluation.inputTokens} in, ${evaluation.outputTokens} out.`,
    `- Estimated stand-in cost: ${estimateCostUsd(evaluation.inputTokens, evaluation.outputTokens).toFixed(6)} USD.`,
    `- Large pull request: displayed ${evaluation.largeDisplayed}, must-review ${evaluation.largeMustReview}, needs-context ${evaluation.largeNeedsContext}, low-priority ${evaluation.largeLowPriority}.`,
    "- Reviewer-reported time saved: not measured.",
  ];
}

function ratio(hits: number, total: number): string {
  if (total === 0) {
    return "not defined";
  }
  return `${hits}/${total} (${((hits / total) * 100).toFixed(1)}%)`;
}
