import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REQUIRED_CATEGORIES } from "./evaluation/dataset.js";
import { evaluateReviewFocus } from "./evaluation/measure.js";
import { metricLines, renderReport } from "./evaluation/report.js";

const reportPath = resolve("tests/fixtures/evaluation/report.md");

describe("end-to-end evaluation", () => {
  it("measures the synthetic pull request without treating the score as success", async () => {
    const evaluation = await evaluateReviewFocus();
    const markdown = renderReport(evaluation);
    if (process.env.WRITE_EVALUATION_REPORT === "1") {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, markdown);
    }

    expect(evaluation.historicalPullRequests).toBe(0);
    expect(evaluation.files).toBeGreaterThanOrEqual(16);
    expect(evaluation.important).toBeGreaterThanOrEqual(8);
    expect(evaluation.uncertainSilent).toBe(0);
    expect(evaluation.linkResolveFailures).toBe(0);
    expect(evaluation.linksChecked).toBeGreaterThan(0);
    expect(evaluation.rangeMisses).toBeGreaterThan(0);
    expect(evaluation.rangeMissPaths).toContain("src/unmapped-fee.ts");
    expect(evaluation.summaryExtras).toBe(0);
    expect(evaluation.inlineExtras).toBe(0);
    expect(evaluation.latencyMs).toBeGreaterThan(0);
    expect(evaluation.latencyMs).toBeLessThan(60_000);
    expect(evaluation.largeLatencyMs).toBeLessThan(60_000);
    expect(evaluation.largeFiles).toBe(30);

    const categories = new Set(evaluation.outcomes.map((outcome) => outcome.category));
    for (const category of REQUIRED_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }

    for (const failure of evaluation.failures) {
      expect(failure.observed).not.toMatch(
        /was accepted|was ignored|A moved head|did not publish|Partial publishing left|Rate limit retry/u,
      );
    }
    for (const item of evaluation.security) {
      expect(item.observed).not.toMatch(/ran during|not limited|fetched a pull request/u);
    }

    const limits = readFileSync(resolve("src/llm/limits.ts"), "utf8");
    expect(limits).toContain("const INPUT_USD_PER_MILLION = 3;");
    expect(limits).toContain("const OUTPUT_USD_PER_MILLION = 15;");

    const committed = readFileSync(reportPath, "utf8");
    expect(committed).toContain("Pilot readiness: Not ready.");
    expect(committed).toContain("Reviewer-reported time saved: not measured.");
    expect(committed).toContain("Historical pull requests: 0");
    expect(committed).not.toContain("production ready");
    for (const line of metricLines(evaluation)) {
      expect(markdown).toContain(line);
      expect(committed).toContain(line);
    }
  });
});
