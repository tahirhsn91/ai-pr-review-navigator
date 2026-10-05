import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { BlockAssessment } from "../src/analysis/types.js";
import { createPrioritizer, PrioritizationError } from "../src/prioritization/index.js";
import type { FocusReport, RankBlocksRequest } from "../src/prioritization/types.js";
import type { LogicalBlock } from "../src/parser/types.js";
import { ATTENTION_REASONS } from "../src/shared/vocabulary.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const prioritizer = createPrioritizer();
const rank = (input: RankBlocksRequest): FocusReport => prioritizer.rank(input);

function policy(selection?: {
  readonly maxBlocks?: number;
  readonly minBand?: "low" | "medium" | "high";
}): RankBlocksRequest["policy"] {
  return {
    version: 1,
    selection: {
      maxBlocks: selection?.maxBlocks ?? 12,
      minBand: selection?.minBand ?? "medium",
    },
    ignore: ["**/dist/**"],
    languages: ["typescript"],
    attention: [...ATTENTION_REASONS],
    criticality: [
      "Payment capture changes what a customer is charged.",
      "Authorization checks control access to an account.",
    ],
  };
}

function block(overrides: Partial<LogicalBlock> & Pick<LogicalBlock, "id">): LogicalBlock {
  return {
    path: "src/billing.ts",
    kind: "function",
    name: "bill",
    enclosingSymbol: null,
    context: [],
    baseRange: { startLine: 1, endLine: 10 },
    headRange: { startLine: 1, endLine: 10 },
    changedLines: [{ side: "head", range: { startLine: 4, endLine: 4 } }],
    change: "modified",
    confidence: "high",
    parseStatus: "parsed",
    ...overrides,
  };
}

function assessment(
  blockId: string,
  overrides: Partial<Omit<BlockAssessment, "blockId">> = {},
): BlockAssessment {
  return {
    blockId,
    behaviorChanged: true,
    businessImpact: "significant",
    reviewReason: "The block behavior changed.",
    evidence: ["The head source differs from the base source."],
    contextRequired: [],
    confidence: "high",
    uncertaintyReasons: [],
    signals: [],
    ...overrides,
  };
}

function request(
  blocks: readonly LogicalBlock[],
  assessments: readonly BlockAssessment[],
  overrides: Partial<
    Omit<RankBlocksRequest, "blocks" | "assessments" | "baseSha" | "headSha">
  > = {},
): RankBlocksRequest {
  return {
    baseSha,
    headSha,
    blocks,
    assessments,
    policy: policy(),
    ...overrides,
  };
}

describe("prioritization", () => {
  it("ranks a business calculation change as must-review", () => {
    const capture = block({
      id: "calc-capture",
      kind: "calculation",
      name: "capture",
      headRange: { startLine: 2, endLine: 6 },
      changedLines: [{ side: "head", range: { startLine: 4, endLine: 5 } }],
    });
    const report = rank(
      request(
        [capture],
        [
          assessment(capture.id, {
            businessImpact: "critical",
            reviewReason: "Payment capture now charges twice the previous amount.",
            evidence: ["The new block multiplies the captured amount by 2."],
            signals: [{ reason: "public_api", summary: "The captured amount changed." }],
          }),
        ],
        { tests: [] },
      ),
    );

    expect(report.analysisStatus).toBe("complete");
    expect(report.groups.mustReview).toEqual([
      expect.objectContaining({
        blockId: "calc-capture",
        group: "must_review",
        band: "high",
        side: "head",
        range: { startLine: 4, endLine: 5 },
        blockRange: { startLine: 2, endLine: 6 },
        behaviorChanged: true,
        businessImpact: "critical",
        reasons: ["public_api"],
      }),
    ]);
    expect(report.groups.mustReview[0]?.contextRequired).toEqual([
      "No related test was supplied for this block.",
    ]);
    expect(report.displayed.map((item) => item.blockId)).toEqual(["calc-capture"]);
    expect(report.overflow).toEqual([]);
    expect(changedLinesCover(report)).toBe(true);
  });

  it("treats a one-line authorization change as must-review", () => {
    const authorize = block({
      id: "auth-owner",
      kind: "authorization",
      name: "authorize",
      headRange: { startLine: 3, endLine: 5 },
      changedLines: [{ side: "head", range: { startLine: 4, endLine: 4 } }],
    });
    const report = rank(
      request(
        [authorize],
        [
          assessment(authorize.id, {
            businessImpact: "limited",
            reviewReason: "Authorization now requires the account owner.",
            evidence: ["The authorize call checks the account owner."],
            signals: [{ reason: "security_boundary", summary: "The owner check changed." }],
          }),
        ],
      ),
    );

    expect(report.groups.mustReview.map((item) => item.blockId)).toEqual(["auth-owner"]);
    expect(report.groups.mustReview[0]).toMatchObject({
      range: { startLine: 4, endLine: 4 },
      businessImpact: "limited",
      reasons: ["security_boundary"],
    });
    expect(report.groups.reviewIfRelevant).toEqual([]);
  });

  it("does not treat a loop without a behavior change as must-review", () => {
    const loop = block({
      id: "loop-items",
      kind: "loop",
      name: "items",
      headRange: { startLine: 1, endLine: 4 },
      changedLines: [{ side: "head", range: { startLine: 2, endLine: 2 } }],
    });
    const report = rank(
      request(
        [loop],
        [
          assessment(loop.id, {
            behaviorChanged: false,
            businessImpact: "none",
            reviewReason: "The loop still walks the same items.",
            evidence: ["The loop bounds and body are unchanged."],
          }),
        ],
      ),
    );

    expect(report.groups.mustReview).toEqual([]);
    expect(report.groups.lowPriority.map((item) => item.blockId)).toEqual(["loop-items"]);
    expect(report.displayed).toEqual([]);
    expect(report.counts.hiddenLowPriority).toBe(1);
  });

  it("keeps a behavior-changing loop out of must-review when criticality does not apply", () => {
    const loop = block({
      id: "loop-items",
      kind: "loop",
      name: "items",
      headRange: { startLine: 1, endLine: 4 },
      changedLines: [{ side: "head", range: { startLine: 2, endLine: 2 } }],
    });
    const report = rank(
      request(
        [loop],
        [
          assessment(loop.id, {
            businessImpact: "significant",
            reviewReason: "The loop body now skips zero.",
            evidence: ["The head loop contains a zero check."],
          }),
        ],
      ),
    );
    expect(report.groups.mustReview).toEqual([]);
    expect(report.groups.reviewIfRelevant.map((item) => item.blockId)).toEqual(["loop-items"]);
  });

  it("ranks routine formatting as low priority", () => {
    const formatted = block({
      id: "format-label",
      kind: "function",
      name: "label",
      changedLines: [{ side: "head", range: { startLine: 2, endLine: 2 } }],
    });
    const report = rank(
      request(
        [formatted],
        [
          assessment(formatted.id, {
            behaviorChanged: false,
            businessImpact: "none",
            reviewReason: "Formatting and whitespace changed.",
            evidence: ["Only indentation changed."],
          }),
        ],
      ),
    );
    expect(report.groups.lowPriority.map((item) => item.blockId)).toEqual(["format-label"]);
    expect(report.groups.mustReview).toEqual([]);
    expect(report.counts.hiddenLowPriority).toBe(1);
  });

  it("keeps the smaller block when changed ranges overlap", () => {
    const parent = block({
      id: "fn-capture",
      kind: "function",
      name: "capture",
      headRange: { startLine: 1, endLine: 10 },
      changedLines: [{ side: "head", range: { startLine: 4, endLine: 4 } }],
    });
    const child = block({
      id: "calc-amount",
      kind: "calculation",
      name: "amount",
      headRange: { startLine: 4, endLine: 4 },
      changedLines: [{ side: "head", range: { startLine: 4, endLine: 4 } }],
    });
    const report = rank(
      request(
        [parent, child],
        [
          assessment(parent.id, {
            reviewReason: "Payment capture changed.",
            evidence: ["The function result changed."],
          }),
          assessment(child.id, {
            businessImpact: "critical",
            reviewReason: "The captured amount is doubled.",
            evidence: ["amount * 2 replaced amount."],
          }),
        ],
      ),
    );

    expect(report.groups.mustReview.map((item) => item.blockId)).toEqual(["calc-amount"]);
    expect(report.deduplication.duplicatesRemoved).toEqual(["fn-capture"]);
    expect(report.counts.duplicatesRemoved).toBe(1);
    expect(report.groups.mustReview[0]?.range).toEqual({ startLine: 4, endLine: 4 });
  });

  it("expands to the enclosing block when context is required", () => {
    const parent = block({
      id: "fn-capture",
      kind: "function",
      name: "capture",
      headRange: { startLine: 1, endLine: 12 },
    });
    const child = block({
      id: "branch-amount",
      kind: "conditional",
      name: "amount",
      headRange: { startLine: 4, endLine: 6 },
    });
    const report = rank(
      request(
        [parent, child],
        [
          assessment(parent.id, {
            businessImpact: "critical",
            reviewReason: "Payment capture now charges twice the previous amount.",
            evidence: ["The function returns amount * 2."],
          }),
          assessment(child.id, {
            behaviorChanged: false,
            businessImpact: "unknown",
            confidence: "low",
            reviewReason: "The branch could not be assessed on its own.",
            evidence: ["The changed line is inside the branch."],
            contextRequired: ["The enclosing function is required."],
            uncertaintyReasons: ["The enclosing function was not part of the assessment."],
          }),
        ],
      ),
    );

    expect(report.deduplication.expanded).toEqual([{ from: "branch-amount", to: "fn-capture" }]);
    expect(report.groups.mustReview.map((item) => item.blockId)).toEqual(["fn-capture"]);
    expect(report.groups.needsContext).toEqual([]);
    expect(selectedIds(report)).not.toContain("branch-amount");
  });

  it("keeps missing context explicit instead of low priority", () => {
    const unknown = block({
      id: "unknown-change",
      kind: "function",
      name: "adjust",
      confidence: "low",
      parseStatus: "partial",
    });
    const report = rank(
      request(
        [unknown],
        [
          assessment(unknown.id, {
            behaviorChanged: false,
            businessImpact: "none",
            confidence: "low",
            reviewReason: "Behavior was not assessed.",
            evidence: [],
            uncertaintyReasons: [
              "The diff mapping is not reliable enough to treat this assessment as certain.",
            ],
          }),
        ],
      ),
    );

    expect(report.analysisStatus).toBe("partial");
    expect(report.groups.lowPriority).toEqual([]);
    expect(report.groups.needsContext.map((item) => item.blockId)).toEqual(["unknown-change"]);
    expect(report.displayed.map((item) => item.blockId)).toEqual(["unknown-change"]);
    expect(report.groups.needsContext[0]?.uncertaintyReasons.length).toBeGreaterThan(0);
  });

  it("shows overflow when must-review blocks exceed the display budget", () => {
    const blocks = [
      block({
        id: "calc-capture",
        path: "src/capture.ts",
        kind: "calculation",
        name: "capture",
      }),
      block({
        id: "calc-refund",
        path: "src/refund.ts",
        kind: "calculation",
        name: "refund",
      }),
      block({
        id: "auth-owner",
        path: "src/auth.ts",
        kind: "authorization",
        name: "authorize",
      }),
    ];
    const report = rank(
      request(
        blocks,
        [
          assessment("calc-capture", {
            businessImpact: "critical",
            reviewReason: "Payment capture now charges twice the previous amount.",
            evidence: ["The captured amount is multiplied by 2."],
          }),
          assessment("calc-refund", {
            reviewReason: "Refunds now return the captured amount.",
            evidence: ["The refund total uses the captured amount."],
          }),
          assessment("auth-owner", {
            businessImpact: "limited",
            reviewReason: "Authorization now requires the account owner.",
            evidence: ["The owner check was added."],
          }),
        ],
        { policy: policy({ maxBlocks: 1, minBand: "medium" }) },
      ),
    );

    expect(report.groups.mustReview.map((item) => item.blockId)).toEqual([
      "calc-capture",
      "calc-refund",
      "auth-owner",
    ]);
    expect(report.displayed.map((item) => item.blockId)).toEqual(["calc-capture"]);
    expect(report.overflow.map((item) => item.blockId)).toEqual(["calc-refund", "auth-owner"]);
    expect(report.counts.overflow).toBe(2);
    expect(report.counts.selected).toBe(3);
  });

  it("returns the same report for the same inputs", () => {
    const item = block({ id: "calc-capture", kind: "calculation", name: "capture" });
    const input = request(
      [item],
      [
        assessment(item.id, {
          businessImpact: "critical",
          reviewReason: "Payment capture changed.",
        }),
      ],
    );
    expect(rank(input)).toEqual(rank(input));
  });

  it("rejects an invalid SHA without repeating the value", () => {
    const item = block({ id: "calc-capture" });
    const secret = "not-a-real-sha";
    expect(() =>
      rank(
        request([item], [assessment(item.id)], {
          policy: policy(),
        }),
      ),
    ).not.toThrow();
    expect(() =>
      rank({
        ...request([item], [assessment(item.id)]),
        baseSha: secret,
      }),
    ).toThrow(PrioritizationError);
    try {
      rank({
        ...request([item], [assessment(item.id)]),
        baseSha: secret,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PrioritizationError);
      if (error instanceof Error) {
        expect(error.message).toMatch(/baseSha/);
        expect(error.message).not.toContain(secret);
      }
    }
  });

  it("matches the checked-in example report", () => {
    const calculation = block({
      id: "calc-capture",
      kind: "calculation",
      name: "capture",
      headRange: { startLine: 2, endLine: 6 },
      changedLines: [{ side: "head", range: { startLine: 4, endLine: 5 } }],
    });
    const calculationReport = rank(
      request(
        [calculation],
        [
          assessment(calculation.id, {
            businessImpact: "critical",
            reviewReason: "Payment capture now charges twice the previous amount.",
            evidence: ["The new block multiplies the captured amount by 2."],
            signals: [{ reason: "public_api", summary: "The captured amount changed." }],
          }),
        ],
        { tests: [] },
      ),
    );
    const overflowBlocks = [
      block({ id: "calc-capture", path: "src/capture.ts", kind: "calculation", name: "capture" }),
      block({ id: "calc-refund", path: "src/refund.ts", kind: "calculation", name: "refund" }),
      block({ id: "auth-owner", path: "src/auth.ts", kind: "authorization", name: "authorize" }),
    ];
    const overflowReport = rank(
      request(
        overflowBlocks,
        [
          assessment("calc-capture", {
            businessImpact: "critical",
            reviewReason: "Payment capture now charges twice the previous amount.",
            evidence: ["The captured amount is multiplied by 2."],
          }),
          assessment("calc-refund", {
            reviewReason: "Refunds now return the captured amount.",
            evidence: ["The refund total uses the captured amount."],
          }),
          assessment("auth-owner", {
            businessImpact: "limited",
            reviewReason: "Authorization now requires the account owner.",
            evidence: ["The owner check was added."],
          }),
        ],
        { policy: policy({ maxBlocks: 1 }) },
      ),
    );
    const fixture = JSON.parse(
      readFileSync(join("tests", "fixtures", "prioritization", "examples.json"), "utf8"),
    ) as {
      calculation: FocusReport;
      overflow: FocusReport;
    };
    expect(exampleOf(calculationReport)).toEqual(fixture.calculation);
    expect(exampleOf(overflowReport)).toEqual(fixture.overflow);
  });
});

function selectedIds(report: FocusReport): string[] {
  return [
    ...report.groups.mustReview,
    ...report.groups.reviewIfRelevant,
    ...report.groups.lowPriority,
    ...report.groups.needsContext,
  ].map((item) => item.blockId);
}

function changedLinesCover(report: FocusReport): boolean {
  return selectedIds(report).every((id) => {
    const item = [
      ...report.groups.mustReview,
      ...report.groups.reviewIfRelevant,
      ...report.groups.lowPriority,
      ...report.groups.needsContext,
    ].find((candidate) => candidate.blockId === id);
    return (
      item !== undefined &&
      item.range.startLine >= item.blockRange.startLine &&
      item.range.endLine <= item.blockRange.endLine
    );
  });
}

function exampleOf(report: FocusReport): unknown {
  const summarize = (items: FocusReport["displayed"]) =>
    items.map((item) => ({
      blockId: item.blockId,
      path: item.path,
      group: item.group,
      band: item.band,
      rank: item.rank,
      range: item.range,
      blockRange: item.blockRange,
      reviewReason: item.reviewReason,
      evidence: item.evidence,
      confidence: item.confidence,
      uncertaintyReasons: item.uncertaintyReasons,
      businessImpact: item.businessImpact,
      behaviorChanged: item.behaviorChanged,
    }));
  return {
    baseSha: report.baseSha,
    headSha: report.headSha,
    analysisStatus: report.analysisStatus,
    groups: {
      mustReview: summarize(report.groups.mustReview),
      reviewIfRelevant: summarize(report.groups.reviewIfRelevant),
      lowPriority: summarize(report.groups.lowPriority),
      needsContext: summarize(report.groups.needsContext),
    },
    displayed: report.displayed.map((item) => item.blockId),
    overflow: report.overflow.map((item) => item.blockId),
    counts: report.counts,
    deduplication: report.deduplication,
  };
}
