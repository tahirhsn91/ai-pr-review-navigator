import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { createFoundationPipeline } from "../src/pipeline.js";
import { NotImplementedError } from "../src/shared/errors.js";
import type { AttentionSignal, BlockAssessment } from "../src/analysis/types.js";
import type { ReviewFocusReport } from "../src/publisher/types.js";
import type { LogicalBlock } from "../src/parser/types.js";

const signal: AttentionSignal = {
  reason: "public_api",
  summary: "Exported signature changed.",
};

const block: LogicalBlock = {
  id: "block-1",
  path: "src/example.ts",
  kind: "function",
  name: "example",
  enclosingSymbol: null,
  context: [],
  baseRange: { startLine: 1, endLine: 4 },
  headRange: { startLine: 1, endLine: 4 },
  changedLines: [{ side: "head", range: { startLine: 2, endLine: 3 } }],
  change: "modified",
  confidence: "high",
  parseStatus: "parsed",
};

const assessment: BlockAssessment = {
  blockId: block.id,
  signals: [signal],
};

const report: ReviewFocusReport = {
  pullRequest: { owner: "example", repo: "demo", number: 1 },
  headSha: "a".repeat(40),
  items: [],
  omittedCount: 0,
};

async function stageError(run: () => unknown): Promise<unknown> {
  const returned = await Promise.resolve()
    .then(run)
    .then(() => "returned-a-value")
    .catch((caught: unknown) => caught);
  return returned;
}

describe("foundation pipeline", () => {
  it("fails closed on stages that are not implemented yet", async () => {
    const pipeline = createFoundationPipeline();
    const policy = loadConfig({
      cwd: process.cwd(),
      env: { GITHUB_TOKEN: "test-token", LLM_PROVIDER: "none" },
    }).policy;

    const stages: Array<{ name: string; feature: string; run: () => unknown }> = [
      {
        name: "fetchPullRequest",
        feature: "GitHubClient.fetchPullRequest",
        run: () => pipeline.fetchPullRequest({ owner: "example", repo: "demo", number: 1 }),
      },
      {
        name: "fetchFileText",
        feature: "GitHubClient.fetchFileText",
        run: () =>
          pipeline.fetchFileText({
            owner: "example",
            repo: "demo",
            path: "src/example.ts",
            sha: "a".repeat(40),
          }),
      },
      {
        name: "parseDiffs",
        feature: "DiffParser.parse",
        run: () => pipeline.parseDiffs([]),
      },
      {
        name: "findChangedBlocks",
        feature: "CodeParser.findChangedBlocks",
        run: () => pipeline.findChangedBlocks({ diffs: [], sources: [] }),
      },
      {
        name: "assessBlocks",
        feature: "ReviewFocusAnalyzer.assess",
        run: () => pipeline.assessBlocks({ blocks: [block], enabledReasons: ["public_api"] }),
      },
      {
        name: "rankBlocks",
        feature: "Prioritizer.rank",
        run: () => pipeline.rankBlocks({ blocks: [block], assessments: [assessment], policy }),
      },
      {
        name: "explainAttention",
        feature: "LlmProvider.explainAttention",
        run: () =>
          pipeline.explainAttention({
            path: block.path,
            blockName: block.name,
            language: "typescript",
            reasons: ["public_api"],
            excerpt: "export function example() { return 1; }",
          }),
      },
      {
        name: "publish",
        feature: "ReviewPublisher.publish",
        run: () => pipeline.publish(report),
      },
    ];

    expect(stages.map((stage) => stage.name).sort()).toEqual(Object.keys(pipeline).sort());

    for (const stage of stages) {
      if (stage.name === "parseDiffs" || stage.name === "findChangedBlocks") {
        continue;
      }
      const error = await stageError(stage.run);
      expect(error).toBeInstanceOf(NotImplementedError);
      if (error instanceof NotImplementedError) {
        expect(error.code).toBe("not_implemented");
        expect(error.message).toContain(stage.feature);
      }
    }
  });

  it("parses diff hunks in the pipeline", () => {
    const pipeline = createFoundationPipeline();
    const parsed = pipeline.parseDiffs([
      {
        filename: "src/a.ts",
        status: "modified",
        patch: ["@@ -1 +1 @@", "-before", "+after"].join("\n"),
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      path: "src/a.ts",
      patchStatus: "parsed",
      lineMappingComplete: true,
      addedRanges: [{ startLine: 1, endLine: 1 }],
      removedRanges: [{ startLine: 1, endLine: 1 }],
    });
  });

  it("maps a changed statement to its enclosing block", async () => {
    const pipeline = createFoundationPipeline();
    const blocks = await pipeline.findChangedBlocks({
      diffs: [
        {
          path: "src/price.ts",
          status: "modified",
          hunks: [],
          addedRanges: [{ startLine: 2, endLine: 2 }],
          removedRanges: [{ startLine: 2, endLine: 2 }],
          patchStatus: "parsed",
          lineMappingComplete: true,
        },
      ],
      sources: [
        {
          path: "src/price.ts",
          baseText: "export function price(value: number) {\n  return 0;\n}\n",
          headText: "export function price(value: number) {\n  return value;\n}\n",
        },
      ],
    });
    expect(blocks.some((item) => item.kind === "return" && item.enclosingSymbol === "price")).toBe(
      true,
    );
    expect(blocks.some((item) => item.kind === "loop")).toBe(false);
  });
});
