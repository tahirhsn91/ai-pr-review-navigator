import { createUnimplementedAnalyzer } from "./analysis/index.js";
import type { AssessBlocksRequest, BlockAssessment } from "./analysis/types.js";
import { createDiffParser } from "./diff/index.js";
import type { FileDiff } from "./diff/types.js";
import { createUnimplementedGitHubClient } from "./github/index.js";
import type {
  FileTextRequest,
  PullRequestFile,
  PullRequestRef,
  PullRequestSnapshot,
} from "./github/types.js";
import { unimplementedExplainAttention } from "./llm/index.js";
import type { AttentionExplanation, ExplainAttentionRequest } from "./llm/types.js";
import { createCodeParser } from "./parser/index.js";
import type { ChangedBlockRequest, LogicalBlock } from "./parser/types.js";
import { createUnimplementedPrioritizer } from "./prioritization/index.js";
import type { RankBlocksRequest, RankedBlock } from "./prioritization/types.js";
import { createUnimplementedPublisher } from "./publisher/index.js";
import type { PublishReceipt, ReviewFocusReport } from "./publisher/types.js";

export interface ReviewPipeline {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequestSnapshot>;
  fetchFileText(request: FileTextRequest): Promise<string>;
  parseDiffs(files: readonly PullRequestFile[]): readonly FileDiff[];
  findChangedBlocks(input: ChangedBlockRequest): Promise<readonly LogicalBlock[]>;
  assessBlocks(input: AssessBlocksRequest): Promise<readonly BlockAssessment[]>;
  rankBlocks(input: RankBlocksRequest): readonly RankedBlock[];
  explainAttention(request: ExplainAttentionRequest): Promise<AttentionExplanation>;
  publish(report: ReviewFocusReport): Promise<PublishReceipt>;
}

export function createFoundationPipeline(): ReviewPipeline {
  const github = createUnimplementedGitHubClient();
  const diffs = createDiffParser();
  const parser = createCodeParser();
  const analysis = createUnimplementedAnalyzer();
  const prioritization = createUnimplementedPrioritizer();
  const explainAttention = unimplementedExplainAttention();
  const publisher = createUnimplementedPublisher();

  return {
    fetchPullRequest: (ref) => github.fetchPullRequest(ref),
    fetchFileText: (request) => github.fetchFileText(request),
    parseDiffs: (files) => diffs.parse(files),
    findChangedBlocks: (input) => parser.findChangedBlocks(input),
    assessBlocks: (input) => analysis.assess(input),
    rankBlocks: (input) => prioritization.rank(input),
    explainAttention: (request) => explainAttention(request),
    publish: (report) => publisher.publish(report),
  };
}
