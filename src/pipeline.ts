import { createSemanticAnalyzer } from "./analysis/index.js";
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
import { createPrioritizer } from "./prioritization/index.js";
import type { FocusReport, RankBlocksRequest } from "./prioritization/types.js";
import { PublishUnavailableError } from "./publisher/index.js";
import type {
  PublishReceipt,
  ReviewFocusItem,
  ReviewFocusReport,
  ReviewPublisher,
} from "./publisher/types.js";

export interface ReviewPipeline {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequestSnapshot>;
  fetchFileText(request: FileTextRequest): Promise<string>;
  parseDiffs(files: readonly PullRequestFile[]): readonly FileDiff[];
  findChangedBlocks(input: ChangedBlockRequest): Promise<readonly LogicalBlock[]>;
  assessBlocks(input: AssessBlocksRequest): Promise<readonly BlockAssessment[]>;
  rankBlocks(input: RankBlocksRequest): FocusReport;
  explainAttention(request: ExplainAttentionRequest): Promise<AttentionExplanation>;
  publish(report: ReviewFocusReport): Promise<PublishReceipt>;
}

export interface FoundationPipelineOptions {
  readonly publisher?: ReviewPublisher;
}

export function toReviewFocusReport(
  pullRequest: ReviewFocusReport["pullRequest"],
  report: FocusReport,
): ReviewFocusReport {
  const blocks: ReviewFocusItem[] = [
    ...report.groups.mustReview,
    ...report.groups.reviewIfRelevant,
    ...report.groups.lowPriority,
    ...report.groups.needsContext,
  ].map((block) => ({
    blockId: block.blockId,
    path: block.path,
    name: block.name,
    range: block.range,
    blockRange: block.blockRange,
    side: block.side,
    reviewReason: block.reviewReason,
    group: block.group,
  }));
  return {
    pullRequest,
    baseSha: report.baseSha,
    headSha: report.headSha,
    analysisStatus: report.analysisStatus,
    overflowCount: report.counts.overflow,
    blocks,
  };
}

export function createFoundationPipeline(options: FoundationPipelineOptions = {}): ReviewPipeline {
  const github = createUnimplementedGitHubClient();
  const diffs = createDiffParser();
  const parser = createCodeParser();
  const analysis = createSemanticAnalyzer();
  const prioritization = createPrioritizer();
  const explainAttention = unimplementedExplainAttention();
  const publisher = options.publisher;

  return {
    fetchPullRequest: (ref) => github.fetchPullRequest(ref),
    fetchFileText: (request) => github.fetchFileText(request),
    parseDiffs: (files) => diffs.parse(files),
    findChangedBlocks: (input) => parser.findChangedBlocks(input),
    assessBlocks: (input) => analysis.assess(input),
    rankBlocks: (input) => prioritization.rank(input),
    explainAttention: (request) => explainAttention(request),
    publish: (report) => {
      if (publisher === undefined) {
        return Promise.reject(new PublishUnavailableError());
      }
      return publisher.publish(report);
    },
  };
}
