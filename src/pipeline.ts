import { AnalysisError, LlmUnavailableError } from "./analysis/errors.js";
import { createSemanticAnalyzer } from "./analysis/index.js";
import type { AssessBlocksRequest, BlockAssessment } from "./analysis/types.js";
import { loadConfig } from "./config/index.js";
import type { AppConfig } from "./config/index.js";
import { createDiffParser, processPullRequestDiff } from "./diff/index.js";
import type { FileDiff, PullRequestDiff } from "./diff/types.js";
import { GitHubRequestError } from "./github/errors.js";
import { createGitHubClient, createUnimplementedGitHubClient } from "./github/index.js";
import type {
  FileTextRequest,
  GitHubClient,
  PullRequestFile,
  PullRequestRef,
  PullRequestSnapshot,
} from "./github/types.js";
import {
  createLlmProvider,
  LlmLimitError,
  LlmRequestError,
  unimplementedExplainAttention,
} from "./llm/index.js";
import type { AttentionExplanation, ExplainAttentionRequest, LlmProvider } from "./llm/types.js";
import { createCodeParser } from "./parser/index.js";
import type { ChangedBlockRequest, LogicalBlock, SourceFile } from "./parser/types.js";
import { createPrioritizer } from "./prioritization/index.js";
import type { FocusReport, RankBlocksRequest } from "./prioritization/types.js";
import {
  PublishError,
  PublishUnavailableError,
  createReviewPublisher,
  keepPriorSummary,
} from "./publisher/index.js";
import type {
  PublishReceipt,
  PublishedStatus,
  ReviewFocusItem,
  ReviewFocusReport,
  ReviewPublisher,
} from "./publisher/types.js";
import { ConfigError, ReviewNavigatorError } from "./shared/errors.js";

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

export type ReviewRunOutcome = "published" | "stale" | "preserved";

export interface ReviewRunResult {
  readonly outcome: ReviewRunOutcome;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly analysisStatus?: PublishedStatus;
}

export interface ReanalyzeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly client?: GitHubClient;
  readonly publisher?: ReviewPublisher;
  readonly model?: LlmProvider;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function reanalyzePullRequest(options: ReanalyzeOptions): Promise<ReviewRunResult> {
  const ref = pullRequestRef(options.env);
  const cwd = options.cwd ?? process.cwd();
  const token = requiredEnv(options.env, "GITHUB_TOKEN");
  const client = options.client ?? createGitHubClient(clientOptions(token, options));
  const publisher = options.publisher ?? createPublisher(token, options);
  const policy = loadConfig({
    env: { ...options.env, LLM_PROVIDER: "none", GITHUB_TOKEN: token },
    cwd,
  }).policy;

  let diff: PullRequestDiff;
  try {
    diff = await processPullRequestDiff({ client, ref });
  } catch (error) {
    return recover(options, ref, token, undefined, error);
  }

  let failed: boolean;
  let blocks: readonly LogicalBlock[] = [];
  let focus: FocusReport;
  try {
    const sources = diff.files.map(sourceFile);
    blocks = await createCodeParser().findChangedBlocks({
      diffs: diff.files,
      sources,
      ignore: policy.ignore,
      languages: policy.languages,
    });
    const resolved = resolveModel(options, cwd);
    failed = resolved.failed;
    const assessments = await assessChangedBlocks(blocks, sources, policy, resolved.model);
    focus = createPrioritizer().rank({
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      blocks,
      assessments,
      policy,
    });
  } catch (error) {
    if (isModelFailure(error) && blocks.length > 0) {
      return publishUnassessed(options, client, publisher, ref, diff, blocks, policy);
    }
    return recover(options, ref, token, diff, error, !(error instanceof GitHubRequestError));
  }

  let current: PullRequestSnapshot;
  try {
    current = await client.fetchPullRequest(ref);
  } catch (error) {
    return recover(options, ref, token, diff, error, false);
  }
  if (current.headSha !== diff.headSha) {
    return { outcome: "stale", baseSha: diff.baseSha, headSha: diff.headSha };
  }
  if (failed && focus.groups.mustReview.length + counted(focus) === 0) {
    return recover(options, ref, token, diff, new AnalysisError("Analysis produced no blocks."));
  }
  const report = toReviewFocusReport(ref, focus);
  await publisher.publish(failed ? { ...report, analysisStatus: "unavailable" } : report);
  return {
    outcome: "published",
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    analysisStatus: failed ? "unavailable" : report.analysisStatus,
  };
}

function counted(focus: FocusReport): number {
  return (
    focus.groups.reviewIfRelevant.length +
    focus.groups.lowPriority.length +
    focus.groups.needsContext.length
  );
}

async function publishUnassessed(
  options: ReanalyzeOptions,
  client: GitHubClient,
  publisher: ReviewPublisher,
  ref: PullRequestRef,
  diff: PullRequestDiff,
  blocks: readonly LogicalBlock[],
  policy: ReturnType<typeof loadConfig>["policy"],
): Promise<ReviewRunResult> {
  const assessments = blocks.map((block) =>
    unassessed(block, "The model response could not be used."),
  );
  const focus = createPrioritizer().rank({
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    blocks,
    assessments,
    policy,
  });
  let current: PullRequestSnapshot;
  try {
    current = await client.fetchPullRequest(ref);
  } catch (error) {
    return recover(options, ref, requiredEnv(options.env, "GITHUB_TOKEN"), diff, error, false);
  }
  if (current.headSha !== diff.headSha) {
    return { outcome: "stale", baseSha: diff.baseSha, headSha: diff.headSha };
  }
  if (counted(focus) + focus.groups.mustReview.length === 0) {
    return recover(
      options,
      ref,
      requiredEnv(options.env, "GITHUB_TOKEN"),
      diff,
      new AnalysisError("Analysis produced no blocks."),
    );
  }
  const report = {
    ...toReviewFocusReport(ref, focus),
    analysisStatus: "unavailable" as const,
  };
  await publisher.publish(report);
  return {
    outcome: "published",
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    analysisStatus: "unavailable",
  };
}

async function recover(
  options: ReanalyzeOptions,
  ref: PullRequestRef,
  token: string,
  diff: PullRequestDiff | undefined,
  error: unknown,
  publishEmpty = true,
): Promise<ReviewRunResult> {
  let kept: "preserved" | "absent";
  try {
    kept = await keepPriorSummary({
      token,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  } catch (preserveError) {
    throw error instanceof ReviewNavigatorError ? error : preserveError;
  }
  if (kept === "preserved") {
    return {
      outcome: "preserved",
      ...(diff === undefined ? {} : { baseSha: diff.baseSha, headSha: diff.headSha }),
      analysisStatus: "unavailable",
    };
  }
  if (publishEmpty && diff !== undefined) {
    const publisher = options.publisher ?? createPublisher(token, options);
    await publisher.publish({
      pullRequest: ref,
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      analysisStatus: "unavailable",
      overflowCount: 0,
      blocks: [],
    });
    return {
      outcome: "published",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      analysisStatus: "unavailable",
    };
  }
  throw error;
}

async function assessChangedBlocks(
  blocks: readonly LogicalBlock[],
  sources: readonly SourceFile[],
  policy: ReturnType<typeof loadConfig>["policy"],
  model: LlmProvider | undefined,
): Promise<readonly BlockAssessment[]> {
  if (blocks.length === 0) {
    return [];
  }
  if (model === undefined) {
    return blocks.map((block) => unassessed(block, "LLM provider is not configured."));
  }
  return createSemanticAnalyzer().assess({
    blocks,
    sources,
    enabledReasons: policy.attention,
    provider: model,
    businessCriticality: policy.criticality,
  });
}

function resolveModel(
  options: ReanalyzeOptions,
  cwd: string,
): { readonly model?: LlmProvider; readonly failed: boolean } {
  if (options.model !== undefined) {
    return { model: options.model, failed: false };
  }
  try {
    const config = loadConfig({ env: options.env, cwd });
    if (config.llmProvider === "none") {
      return { failed: false };
    }
    return { model: providerFor(config), failed: false };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { failed: true };
    }
    throw error;
  }
}

function providerFor(config: AppConfig & { readonly llmProvider: "claude" | "gpt" }): LlmProvider {
  return createLlmProvider({
    provider: config.llmProvider,
    apiKey: config.llmApiKey,
    ...(config.llmModel === undefined ? {} : { model: config.llmModel }),
  });
}

function unassessed(block: LogicalBlock, reason: string): BlockAssessment {
  return {
    blockId: block.id,
    behaviorChanged: false,
    businessImpact: "unknown",
    reviewReason: "Behavior was not assessed.",
    evidence: [],
    contextRequired: ["Base or head source for this block."],
    confidence: "low",
    uncertaintyReasons: [reason],
    signals: [],
  };
}

function sourceFile(file: PullRequestDiff["files"][number]): SourceFile {
  return {
    path: file.path,
    baseText: file.base.status === "present" ? file.base.text : null,
    headText: file.head.status === "present" ? file.head.text : null,
  };
}

function isModelFailure(error: unknown): boolean {
  return (
    error instanceof LlmRequestError ||
    error instanceof LlmLimitError ||
    error instanceof LlmUnavailableError ||
    error instanceof AnalysisError
  );
}

function createPublisher(token: string, options: ReanalyzeOptions): ReviewPublisher {
  return createReviewPublisher({
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

function clientOptions(token: string, options: ReanalyzeOptions) {
  return {
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}

export function reanalyzeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const reviewToken = env.REVIEW_GITHUB_TOKEN;
  const repository = env.REVIEW_REPOSITORY;
  return {
    ...env,
    ...(reviewToken !== undefined && reviewToken.trim().length > 0
      ? { GITHUB_TOKEN: reviewToken }
      : {}),
    ...(repository !== undefined && repository.trim().length > 0
      ? { GITHUB_REPOSITORY: repository.trim() }
      : {}),
  };
}

function pullRequestRef(env: ReanalyzeOptions["env"]): PullRequestRef {
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const pullRequest = requiredEnv(env, "REVIEW_PULL_REQUEST");
  const separator = repository.indexOf("/");
  const owner = separator > 0 ? repository.slice(0, separator) : "";
  const repo = separator > 0 ? repository.slice(separator + 1) : "";
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new PublishError("GITHUB_REPOSITORY must be an owner/repo name.");
  }
  if (!/^[1-9]\d*$/u.test(pullRequest)) {
    throw new PublishError("REVIEW_PULL_REQUEST must be a pull request number.");
  }
  return { owner, repo, number: Number(pullRequest) };
}

export function reanalyzeFailureMessage(error: unknown): string {
  return error instanceof ReviewNavigatorError
    ? error.message
    : "Unable to reanalyze the pull request.";
}

function requiredEnv(env: ReanalyzeOptions["env"], name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new PublishError(`${name} is not set.`);
  }
  return value;
}
