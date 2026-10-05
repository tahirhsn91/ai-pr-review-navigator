import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AnalysisError } from "../../src/analysis/index.js";
import type { SemanticModel } from "../../src/analysis/types.js";
import { loadConfig } from "../../src/config/index.js";
import type { ReviewFocusPolicy } from "../../src/config/index.js";
import { createDiffParser } from "../../src/diff/index.js";
import { GitHubRequestError } from "../../src/github/errors.js";
import type { PullRequestFile } from "../../src/github/types.js";
import { createLlmProvider, LlmRequestError } from "../../src/llm/index.js";
import { estimateTokens } from "../../src/llm/limits.js";
import type { SourceFile } from "../../src/parser/types.js";
import { createFoundationPipeline, toReviewFocusReport } from "../../src/pipeline.js";
import type { FocusReport, RankedBlock } from "../../src/prioritization/types.js";
import { publishReviewFocusFromEnv } from "../../src/publisher/command.js";
import { createReviewPublisher } from "../../src/publisher/publisher.js";
import type { ReviewFocusReport } from "../../src/publisher/types.js";
import { NotImplementedError } from "../../src/shared/errors.js";
import type { LineRange } from "../../src/shared/location.js";
import { bulkRename, labeledDataset } from "./dataset.js";
import type { EvalFile, EvalLabel } from "./dataset.js";
import { createMemoryGitHub } from "./github-memory.js";
import { contextDiff, unifiedDiff } from "./line-diff.js";

export const INPUT_USD_PER_MILLION = 3;
export const OUTPUT_USD_PER_MILLION = 15;
export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
const API_BASE = "https://api.github.test";
const BULK_FILES = 30;
const PUBLISH_TOKEN = "evaluation-token";

export type Placement =
  "must_review" | "review_if_relevant" | "needs_context" | "low_priority" | "absent";

export interface LabelOutcome {
  readonly id: string;
  readonly path: string;
  readonly category: string;
  readonly role: EvalLabel["role"];
  readonly placement: Placement;
}

export interface SelectedBlock {
  readonly blockId: string;
  readonly path: string;
  readonly group: Placement;
  readonly side: "base" | "head";
  readonly startLine: number;
  readonly endLine: number;
}

export interface Evaluation {
  readonly files: number;
  readonly labels: number;
  readonly important: number;
  readonly notImportant: number;
  readonly uncertain: number;
  readonly historicalPullRequests: number;
  readonly outcomes: readonly LabelOutcome[];
  readonly recallHits: number;
  readonly topFiveHits: number;
  readonly precisionHits: number;
  readonly precisionDenom: number;
  readonly unlabeledSelected: readonly SelectedBlock[];
  readonly uncertainSelected: number;
  readonly deprioritizedSafe: number;
  readonly importantMisses: number;
  readonly uncertainSilent: number;
  readonly linksChecked: number;
  readonly linkResolveFailures: number;
  readonly rangeChecks: number;
  readonly rangeMisses: number;
  readonly rangeMissPaths: readonly string[];
  readonly summaryExtras: number;
  readonly publishAttempts: number;
  readonly inlineExtras: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly largeFiles: number;
  readonly largeHiddenLowPriority: number;
  readonly largeDisplayed: number;
  readonly largeMustReview: number;
  readonly largeNeedsContext: number;
  readonly largeLowPriority: number;
  readonly largeInputTokens: number;
  readonly largeOutputTokens: number;
  readonly largeLatencyMs: number;
  readonly failures: readonly { readonly id: string; readonly observed: string }[];
  readonly security: readonly { readonly id: string; readonly observed: string }[];
}

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION
  );
}

export async function evaluateReviewFocus(): Promise<Evaluation> {
  const policy = loadConfig({
    cwd: process.cwd(),
    env: { GITHUB_TOKEN: PUBLISH_TOKEN, LLM_PROVIDER: "none" },
  }).policy;
  const labeled = await rankDataset(labeledDataset(), policy);
  const outcomes = labelOutcomes(labeled.prepared, labeled.focus);
  const selected = reviewBlocks(labeled.focus);
  const precision = precisionOf(selected, outcomes, labeled.prepared);
  const published = toReviewFocusReport(
    { owner: "example", repo: "review-fixtures", number: 15 },
    labeled.focus,
  );
  const github = createMemoryGitHub();
  const publisher = createReviewPublisher({
    token: PUBLISH_TOKEN,
    apiBaseUrl: API_BASE,
    fetch: github.fetch,
    sleep: github.sleep,
  });
  await publisher.publish(published);
  await publisher.publish(published);
  const links = checkLinks(github.summaryBodies().join("\n"), github.reviews(), labeled.prepared);
  const mustReview = published.blocks.filter((block) => block.group === "must_review").length;
  const failures = await failureScenarios(policy, outcomes);
  const security = await securityFindings();
  return {
    files: labeled.prepared.length,
    labels: outcomes.length,
    important: outcomes.filter((item) => item.role === "important").length,
    notImportant: outcomes.filter((item) => item.role === "not_important").length,
    uncertain: outcomes.filter((item) => item.role === "uncertain").length,
    historicalPullRequests: 0,
    outcomes,
    recallHits: outcomes.filter((item) => item.role === "important" && recalled(item.placement))
      .length,
    topFiveHits: topFiveHits(labeled.focus, outcomes, labeled.prepared),
    precisionHits: precision.hits,
    precisionDenom: precision.denominator,
    unlabeledSelected: precision.unlabeled,
    uncertainSelected: precision.uncertain,
    deprioritizedSafe: outcomes.filter(
      (item) => item.role === "not_important" && deprioritized(item.placement),
    ).length,
    importantMisses: outcomes.filter(
      (item) => item.role === "important" && deprioritized(item.placement),
    ).length,
    uncertainSilent: outcomes.filter(
      (item) => item.role === "uncertain" && deprioritized(item.placement),
    ).length,
    linksChecked: links.checked,
    linkResolveFailures: links.resolveFailures,
    rangeChecks: links.rangeChecks,
    rangeMisses: links.rangeMisses,
    rangeMissPaths: links.rangeMissPaths,
    summaryExtras: github.summaryCount() - 1,
    publishAttempts: 2,
    inlineExtras: Math.max(0, github.reviews().length - mustReview),
    inputTokens: labeled.inputTokens,
    outputTokens: labeled.outputTokens,
    latencyMs: labeled.latencyMs,
    largeFiles: failures.largeFiles,
    largeHiddenLowPriority: failures.largeHidden,
    largeDisplayed: failures.largeDisplayed,
    largeMustReview: failures.largeMustReview,
    largeNeedsContext: failures.largeNeedsContext,
    largeLowPriority: failures.largeLowPriority,
    largeInputTokens: failures.largeInputTokens,
    largeOutputTokens: failures.largeOutputTokens,
    largeLatencyMs: failures.largeLatencyMs,
    failures: failures.rows,
    security,
  };
}

interface Prepared {
  readonly file: EvalFile;
  readonly pull: PullRequestFile;
  readonly source: SourceFile;
  readonly goldHead: readonly number[];
  readonly goldBase: readonly number[];
}

interface RankedDataset {
  readonly prepared: readonly Prepared[];
  readonly focus: FocusReport;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

async function rankDataset(
  files: readonly EvalFile[],
  policy: ReviewFocusPolicy,
): Promise<RankedDataset> {
  const parser = createDiffParser();
  const prepared = files.map((file) => prepare(file, parser));
  const pipeline = createFoundationPipeline();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const started = performance.now();
  const diffs = pipeline.parseDiffs(prepared.map((item) => item.pull));
  const blocks = await pipeline.findChangedBlocks({
    diffs,
    sources: prepared.map((item) => item.source),
    ignore: policy.ignore,
    languages: policy.languages,
  });
  const assessments = await pipeline.assessBlocks({
    blocks,
    enabledReasons: policy.attention,
    provider: standIn(files, usage),
    sources: prepared.map((item) => item.source),
    businessCriticality: policy.criticality,
  });
  const focus = pipeline.rankBlocks({
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    blocks,
    assessments,
    policy,
  });
  return {
    prepared,
    focus,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: performance.now() - started,
  };
}

function prepare(file: EvalFile, parser: ReturnType<typeof createDiffParser>): Prepared {
  const patch = unifiedDiff(file.base, file.head);
  const identity = {
    filename: file.path,
    status: file.status,
    ...(file.previousPath === undefined ? {} : { previousFilename: file.previousPath }),
  };
  const parsed = parser.parse([patch.length === 0 ? identity : { ...identity, patch }]);
  const diff = parsed[0];
  if (diff === undefined) {
    throw new Error(`No diff was produced for ${file.path}.`);
  }
  return {
    file,
    pull: file.withholdPatch || patch.length === 0 ? identity : { ...identity, patch },
    source: { path: file.path, baseText: file.base, headText: file.head },
    goldHead: expand(diff.addedRanges),
    goldBase: expand(diff.removedRanges),
  };
}

function standIn(
  files: readonly EvalFile[],
  usage: { inputTokens: number; outputTokens: number },
): SemanticModel {
  return {
    complete(request) {
      const blockId = promptField(request.user, "candidate");
      const path = promptField(request.user, "path");
      const card = files
        .find((file) => file.path === path)
        ?.cards.find((item) => request.user.includes(item.includes));
      const payload =
        card === undefined
          ? {
              blockId,
              behaviorChanged: false,
              businessImpact: "unknown" as const,
              reviewReason: "The stand-in model did not assess this block.",
              evidence: [],
              contextRequired: ["A stand-in assessment was not authored for this block."],
              confidence: "low" as const,
              uncertaintyReasons: ["The stand-in model did not assess this block."],
            }
          : {
              blockId,
              behaviorChanged: card.behaviorChanged,
              businessImpact: card.businessImpact,
              reviewReason: card.reviewReason,
              evidence: [...card.evidence],
              contextRequired: [],
              confidence: card.confidence,
              uncertaintyReasons: [],
            };
      const text = JSON.stringify(payload);
      usage.inputTokens += estimateTokens(`${request.system}\n${request.user}`);
      usage.outputTokens += estimateTokens(text);
      return Promise.resolve({ text });
    },
  };
}

function promptField(user: string, name: string): string {
  const prefix = `${name}: `;
  const line = user.split("\n").find((item) => item.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Analysis prompt did not include ${name}.`);
  }
  return line.slice(prefix.length);
}

function expand(ranges: readonly LineRange[]): number[] {
  const lines: number[] = [];
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      lines.push(line);
    }
  }
  return lines;
}

function labelOutcomes(prepared: readonly Prepared[], focus: FocusReport): LabelOutcome[] {
  const ranked = allRanked(focus);
  return prepared
    .flatMap((item) =>
      item.file.labels.map((label) => ({
        id: label.id,
        path: item.file.path,
        category: label.category,
        role: label.role,
        placement: placementFor(item.file, label, ranked),
      })),
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function placementFor(file: EvalFile, label: EvalLabel, ranked: readonly RankedBlock[]): Placement {
  const line = lineOf(file, label);
  const hits = ranked.filter(
    (block) =>
      block.path === file.path &&
      block.side === label.side &&
      line >= block.range.startLine &&
      line <= block.range.endLine,
  );
  if (hits.some((block) => block.group === "must_review")) {
    return "must_review";
  }
  if (hits.some((block) => block.group === "review_if_relevant")) {
    return "review_if_relevant";
  }
  if (hits.some((block) => block.group === "needs_context")) {
    return "needs_context";
  }
  if (hits.some((block) => block.group === "low_priority")) {
    return "low_priority";
  }
  return "absent";
}

function lineOf(file: EvalFile, label: EvalLabel): number {
  const text = label.side === "head" ? file.head : file.base;
  if (text === null) {
    throw new Error(`${label.id} has no ${label.side} source.`);
  }
  const matches = text
    .split("\n")
    .map((line, index) => (line.includes(label.needle) ? index + 1 : 0))
    .filter((line) => line > 0);
  const line = matches[0];
  if (matches.length !== 1 || line === undefined) {
    throw new Error(`${label.id} matched ${matches.length} lines.`);
  }
  return line;
}

function allRanked(focus: FocusReport): RankedBlock[] {
  return [
    ...focus.groups.mustReview,
    ...focus.groups.reviewIfRelevant,
    ...focus.groups.needsContext,
    ...focus.groups.lowPriority,
  ];
}

function reviewBlocks(focus: FocusReport): SelectedBlock[] {
  return allRanked(focus)
    .filter((block) => block.group === "must_review" || block.group === "review_if_relevant")
    .map((block) => ({
      blockId: block.blockId,
      path: block.path,
      group: block.group,
      side: block.side,
      startLine: block.range.startLine,
      endLine: block.range.endLine,
    }));
}

function precisionOf(
  selected: readonly SelectedBlock[],
  outcomes: readonly LabelOutcome[],
  prepared: readonly Prepared[],
): { hits: number; denominator: number; unlabeled: SelectedBlock[]; uncertain: number } {
  let hits = 0;
  let uncertain = 0;
  const unlabeled: SelectedBlock[] = [];
  for (const block of selected) {
    const roles = outcomes.filter((outcome) => overlaps(prepared, outcome, block));
    if (roles.some((outcome) => outcome.role === "important")) {
      hits += 1;
    } else if (roles.some((outcome) => outcome.role === "not_important")) {
      continue;
    } else if (roles.some((outcome) => outcome.role === "uncertain")) {
      uncertain += 1;
    } else {
      unlabeled.push(block);
    }
  }
  unlabeled.sort((left, right) =>
    left.path === right.path
      ? left.blockId < right.blockId
        ? -1
        : 1
      : left.path < right.path
        ? -1
        : 1,
  );
  return { hits, denominator: selected.length, unlabeled, uncertain };
}

function overlaps(
  prepared: readonly Prepared[],
  outcome: LabelOutcome,
  block: SelectedBlock,
): boolean {
  const file = prepared.find((item) => item.file.path === outcome.path)?.file;
  const label = file?.labels.find((item) => item.id === outcome.id);
  if (
    file === undefined ||
    label === undefined ||
    block.path !== file.path ||
    block.side !== label.side
  ) {
    return false;
  }
  const line = lineOf(file, label);
  return line >= block.startLine && line <= block.endLine;
}

function recalled(placement: Placement): boolean {
  return placement === "must_review" || placement === "review_if_relevant";
}

function deprioritized(placement: Placement): boolean {
  return placement === "low_priority" || placement === "absent";
}

function topFiveHits(
  focus: FocusReport,
  outcomes: readonly LabelOutcome[],
  prepared: readonly Prepared[],
): number {
  const top = focus.displayed.slice(0, 5).map((block) => ({
    blockId: block.blockId,
    path: block.path,
    group: block.group,
    side: block.side,
    startLine: block.range.startLine,
    endLine: block.range.endLine,
  }));
  return outcomes.filter(
    (outcome) =>
      outcome.role === "important" && top.some((block) => overlaps(prepared, outcome, block)),
  ).length;
}

const BLOB_LINK =
  /https:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/blob\/([0-9a-f]{40})\/([^()\s#]+)(?:#(L\d+(?:-L\d+)?))?/gu;

function checkLinks(
  summary: string,
  reviews: readonly { path: string; line: number; side: string; body: string }[],
  prepared: readonly Prepared[],
): {
  checked: number;
  resolveFailures: number;
  rangeChecks: number;
  rangeMisses: number;
  rangeMissPaths: string[];
} {
  let checked = 0;
  let resolveFailures = 0;
  let rangeChecks = 0;
  let rangeMisses = 0;
  const missPaths = new Set<string>();
  for (const link of readLinks(summary)) {
    checked += 1;
    if (!resolves(link, prepared)) {
      resolveFailures += 1;
    }
    rangeChecks += 1;
    if (!rangeAccurate(link, prepared)) {
      rangeMisses += 1;
      missPaths.add(link.path);
    }
  }
  for (const review of reviews) {
    checked += 1;
    const side = review.side === "LEFT" ? "base" : review.side === "RIGHT" ? "head" : undefined;
    if (
      side === undefined ||
      !lineExists(prepared, review.path, side === "head" ? HEAD_SHA : BASE_SHA, review.line)
    ) {
      resolveFailures += 1;
    }
    for (const link of readLinks(review.body)) {
      checked += 1;
      if (!resolves(link, prepared)) {
        resolveFailures += 1;
      }
    }
  }
  return {
    checked,
    resolveFailures,
    rangeChecks,
    rangeMisses,
    rangeMissPaths: [...missPaths].sort(),
  };
}

interface BlobLink {
  readonly sha: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

function readLinks(text: string): BlobLink[] {
  return [...text.matchAll(BLOB_LINK)].flatMap((match) => {
    const sha = match[3];
    const path = match[4];
    const anchor = match[5];
    if (sha === undefined || path === undefined || anchor === undefined) {
      return [];
    }
    const parsed = /^L(\d+)(?:-L(\d+))?$/u.exec(anchor);
    const start = parsed?.[1];
    if (start === undefined) {
      return [];
    }
    const end = parsed?.[2] ?? start;
    return [
      {
        sha,
        path: path
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/"),
        startLine: Number(start),
        endLine: Number(end),
      },
    ];
  });
}

function resolves(link: BlobLink, prepared: readonly Prepared[]): boolean {
  if (link.sha !== BASE_SHA && link.sha !== HEAD_SHA) {
    return false;
  }
  for (let line = link.startLine; line <= link.endLine; line += 1) {
    if (!lineExists(prepared, link.path, link.sha, line)) {
      return false;
    }
  }
  return link.endLine >= link.startLine;
}

function rangeAccurate(link: BlobLink, prepared: readonly Prepared[]): boolean {
  const file = prepared.find((item) => item.file.path === link.path);
  if (file === undefined) {
    return false;
  }
  const gold = new Set(link.sha === HEAD_SHA ? file.goldHead : file.goldBase);
  for (let line = link.startLine; line <= link.endLine; line += 1) {
    if (!gold.has(line)) {
      return false;
    }
  }
  return gold.size > 0;
}

function lineExists(
  prepared: readonly Prepared[],
  path: string,
  sha: string,
  line: number,
): boolean {
  const file = prepared.find((item) => item.file.path === path)?.file;
  const text = sha === HEAD_SHA ? file?.head : sha === BASE_SHA ? file?.base : null;
  if (text === null || text === undefined) {
    return false;
  }
  return line >= 1 && line <= text.split("\n").length;
}

async function failureScenarios(
  policy: ReviewFocusPolicy,
  outcomes: readonly LabelOutcome[],
): Promise<{
  rows: { id: string; observed: string }[];
  largeFiles: number;
  largeHidden: number;
  largeDisplayed: number;
  largeMustReview: number;
  largeNeedsContext: number;
  largeLowPriority: number;
  largeInputTokens: number;
  largeOutputTokens: number;
  largeLatencyMs: number;
}> {
  const large = await rankDataset(
    Array.from({ length: BULK_FILES }, (_item, index) => bulkRename(index + 1)),
    policy,
  );
  const placement = (id: string) => outcomes.find((item) => item.id === id)?.placement ?? "absent";
  const missingSource = await excludedWithoutSource(policy);
  const rename = await pureRename(policy);
  const invalid = await invalidModel(policy);
  const timeout = await providerTimeout(policy);
  const rate = await rateLimit();
  const permission = await missingPermission();
  const stale = await staleHead();
  const partial = await partialPublish();
  return {
    largeFiles: BULK_FILES,
    largeHidden: large.focus.counts.hiddenLowPriority,
    largeDisplayed: large.focus.counts.displayed,
    largeMustReview: large.focus.groups.mustReview.length,
    largeNeedsContext: large.focus.groups.needsContext.length,
    largeLowPriority: large.focus.groups.lowPriority.length,
    largeInputTokens: large.inputTokens,
    largeOutputTokens: large.outputTokens,
    largeLatencyMs: large.latencyMs,
    rows: [
      {
        id: "large-pr",
        observed: `${BULK_FILES} mechanical files finished. Must-review ${large.focus.groups.mustReview.length}. Needs context ${large.focus.groups.needsContext.length}. Hidden low-priority ${large.focus.counts.hiddenLowPriority}.`,
      },
      {
        id: "missing-patch",
        observed: `src/unmapped-fee.ts, whose patch text was withheld, was placed in ${placement("unmapped-fee")}.`,
      },
      {
        id: "missing-source",
        observed: `Neither patch nor source was excluded ${missingSource.excluded} time(s) and published ${missingSource.published} time(s).`,
      },
      {
        id: "deleted-file",
        observed: `Deleted src/legacy-fee.ts was placed in ${placement("legacy-fee")}.`,
      },
      {
        id: "renamed-file",
        observed: `Renamed access-check landed in ${placement("access-check")}. access-admin landed in ${placement("access-admin")}.`,
      },
      {
        id: "pure-rename",
        observed: `A renamed file with identical contents produced ${rename} review blocks.`,
      },
      {
        id: "invalid-llm",
        observed: invalid,
      },
      {
        id: "provider-timeout",
        observed: timeout,
      },
      {
        id: "rate-limit",
        observed: rate,
      },
      {
        id: "missing-permission",
        observed: permission,
      },
      {
        id: "stale-head",
        observed: stale,
      },
      {
        id: "partial-publish",
        observed: partial,
      },
    ],
  };
}

async function excludedWithoutSource(
  policy: ReviewFocusPolicy,
): Promise<{ excluded: number; published: number }> {
  const pipeline = createFoundationPipeline();
  const diffs = pipeline.parseDiffs([{ filename: "src/missing-source.ts", status: "modified" }]);
  const blocks = await pipeline.findChangedBlocks({
    diffs,
    sources: [{ path: "src/missing-source.ts", baseText: null, headText: null }],
    ignore: policy.ignore,
    languages: policy.languages,
  });
  const assessments = await pipeline.assessBlocks({
    blocks,
    enabledReasons: policy.attention,
    provider: standIn([], { inputTokens: 0, outputTokens: 0 }),
    sources: [{ path: "src/missing-source.ts", baseText: null, headText: null }],
    businessCriticality: policy.criticality,
  });
  const focus = pipeline.rankBlocks({
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    blocks,
    assessments,
    policy,
  });
  return {
    excluded: focus.counts.excludedWithoutChanges + focus.counts.excludedWithoutLocation,
    published: allRanked(focus).filter((block) => block.path === "src/missing-source.ts").length,
  };
}

async function pureRename(policy: ReviewFocusPolicy): Promise<number> {
  const text = "export const marker = 1;\n";
  const pipeline = createFoundationPipeline();
  const diffs = pipeline.parseDiffs([
    {
      filename: "src/renamed-only.ts",
      previousFilename: "src/original-name.ts",
      status: "renamed",
      patch: contextDiff(text),
      additions: 0,
      deletions: 0,
    },
  ]);
  const blocks = await pipeline.findChangedBlocks({
    diffs,
    sources: [{ path: "src/renamed-only.ts", baseText: text, headText: text }],
    ignore: policy.ignore,
    languages: policy.languages,
  });
  return blocks.length;
}

async function invalidModel(policy: ReviewFocusPolicy): Promise<string> {
  const provider = createLlmProvider({
    provider: "claude",
    apiKey: ["test", "key", "value"].join("-"),
    maxAttempts: 1,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ type: "text", text: "not json" }] }), {
          status: 200,
        }),
      ),
    sleep: () => Promise.resolve(),
  });
  try {
    await assessOne(policy, provider);
    return "Invalid model JSON was accepted.";
  } catch (error) {
    if (error instanceof AnalysisError) {
      return "Invalid model JSON raised AnalysisError. No comment was published.";
    }
    throw error;
  }
}

async function providerTimeout(policy: ReviewFocusPolicy): Promise<string> {
  const provider = createLlmProvider({
    provider: "claude",
    apiKey: ["test", "key", "value"].join("-"),
    maxAttempts: 1,
    timeoutMs: 20,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        const fail = (): void => {
          const error = new Error("The operation was aborted.");
          error.name = "TimeoutError";
          reject(error);
        };
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          fail();
          return;
        }
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      }),
    sleep: () => Promise.resolve(),
  });
  try {
    await assessOne(policy, provider);
    return "The provider timeout was ignored.";
  } catch (error) {
    if (error instanceof LlmRequestError && /timed out/u.test(error.message)) {
      return "The provider timed out and raised LlmRequestError. No comment was published.";
    }
    throw error;
  }
}

async function assessOne(policy: ReviewFocusPolicy, provider: SemanticModel): Promise<void> {
  const file = labeledDataset().find((item) => item.path === "src/billing.ts");
  if (file === undefined) {
    throw new Error("The billing fixture is missing.");
  }
  const pipeline = createFoundationPipeline();
  const prepared = prepare(file, createDiffParser());
  const blocks = await pipeline.findChangedBlocks({
    diffs: pipeline.parseDiffs([prepared.pull]),
    sources: [prepared.source],
    ignore: policy.ignore,
    languages: policy.languages,
  });
  await pipeline.assessBlocks({
    blocks,
    enabledReasons: policy.attention,
    provider,
    sources: [prepared.source],
    businessCriticality: policy.criticality,
  });
}

async function rateLimit(): Promise<string> {
  const github = createMemoryGitHub({ rateLimitOnce: true });
  await createReviewPublisher({
    token: PUBLISH_TOKEN,
    apiBaseUrl: API_BASE,
    fetch: github.fetch,
    sleep: github.sleep,
  }).publish(tinyReport());
  if (github.sleepCount() < 1 || github.summaryCount() !== 1) {
    return `Rate limit retry did not publish one summary (sleeps ${github.sleepCount()}, summaries ${github.summaryCount()}).`;
  }
  return "The publisher received HTTP 429 once, retried, and published one summary.";
}

async function missingPermission(): Promise<string> {
  const token = "local-publish-token";
  const github = createMemoryGitHub({ forbiddenToken: token });
  try {
    await createReviewPublisher({
      token,
      apiBaseUrl: API_BASE,
      fetch: github.fetch,
      sleep: github.sleep,
    }).publish(tinyReport());
    return "HTTP 403 was accepted.";
  } catch (error) {
    if (
      error instanceof GitHubRequestError &&
      !error.message.includes(token) &&
      error.message.includes("[redacted]")
    ) {
      return "HTTP 403 returned GitHubRequestError. The token was redacted.";
    }
    throw error;
  }
}

async function staleHead(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "review-focus-"));
  const reportPath = join(directory, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify({
      headSha: HEAD_SHA,
      pullRequest: { owner: "example", repo: "demo", number: 1 },
    }),
  );
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    called = true;
    return Promise.reject(new Error("fetch should not run"));
  };
  try {
    await publishReviewFocusFromEnv({
      GITHUB_TOKEN: PUBLISH_TOKEN,
      GITHUB_REPOSITORY: "example/review-fixtures",
      PUBLISH_PULL_REQUEST: "15",
      REVIEW_FOCUS_REPORT: reportPath,
      PUBLISH_HEAD_SHA: "c".repeat(40),
    });
    return "A moved head SHA was published.";
  } catch (error) {
    if (error instanceof Error && error.message.includes("PUBLISH_HEAD_SHA") && !called) {
      return "Publishing stopped before any request because headSha does not match PUBLISH_HEAD_SHA.";
    }
    throw error;
  } finally {
    globalThis.fetch = original;
  }
}

async function partialPublish(): Promise<string> {
  const github = createMemoryGitHub({ failReviewOnce: true });
  const publisher = createReviewPublisher({
    token: PUBLISH_TOKEN,
    apiBaseUrl: API_BASE,
    fetch: github.fetch,
    sleep: github.sleep,
  });
  const report = tinyReport();
  let failed = false;
  try {
    await publisher.publish(report);
  } catch (error) {
    if (!(error instanceof GitHubRequestError)) {
      throw error;
    }
    failed = true;
  }
  await publisher.publish(report);
  if (!failed || github.summaryCount() !== 1) {
    return `Partial publishing left ${github.summaryCount()} summaries.`;
  }
  return "Inline publishing failed after the summary. The retry left 1 summary.";
}

function tinyReport(): ReviewFocusReport {
  return {
    pullRequest: { owner: "example", repo: "review-fixtures", number: 15 },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    analysisStatus: "complete",
    overflowCount: 0,
    blocks: [
      {
        blockId: "tiny",
        path: "src/billing.ts",
        name: "capture",
        range: { startLine: 2, endLine: 2 },
        blockRange: { startLine: 1, endLine: 3 },
        side: "head",
        reviewReason: "Payment capture changed.",
        group: "must_review",
      },
    ],
  };
}

async function securityFindings(): Promise<{ id: string; observed: string }[]> {
  const unprivileged = readFileSync(resolve(".github/workflows/pr-review-focus.yml"), "utf8");
  const trusted = readFileSync(resolve(".github/workflows/publish-review-focus.yml"), "utf8");
  const tokenGrants = trusted.split("\n").filter((line) => line.includes("github.token"));
  const pipeline = createFoundationPipeline();
  let fetchClosed = false;
  try {
    await pipeline.fetchPullRequest({ owner: "example", repo: "review-fixtures", number: 15 });
  } catch (error) {
    fetchClosed = error instanceof NotImplementedError;
  }
  const untrustedRan = await untrustedCodeRan();
  const forkSafe =
    unprivileged.includes("pull_request:") &&
    !unprivileged.includes("pull_request_target") &&
    unprivileged.includes("contents: read") &&
    unprivileged.includes("pull-requests: read") &&
    !unprivileged.includes("pull-requests: write") &&
    unprivileged.includes('GITHUB_TOKEN: ""');
  const publishSafe =
    trusted.includes("workflow_dispatch:") &&
    !trusted.includes("pull_request_target") &&
    trusted.includes("ref: ${{ github.ref }}") &&
    trusted.includes("persist-credentials: false") &&
    !trusted.includes("github.event.pull_request") &&
    trusted.includes("node dist/publisher/publish-review-focus.js") &&
    tokenGrants.length === 1;
  return [
    {
      id: "fork-workflow",
      observed: forkSafe
        ? "Fork pull requests start only the read-only workflow with blank tokens."
        : "The unprivileged workflow is not limited to a read-only event.",
    },
    {
      id: "trusted-publish",
      observed: publishSafe
        ? "Publish checks out github.ref and holds the write token only on that step."
        : "The publish workflow does not keep the write token on the trusted step.",
    },
    {
      id: "untrusted-code",
      observed: untrustedRan
        ? "Untrusted pull request code ran during parsing."
        : "A throwing fixture was parsed and assessed without executing the throw.",
    },
    {
      id: "privileged-fetch",
      observed: fetchClosed
        ? "Foundation fetch remains unimplemented, so private history was not retrieved."
        : "createFoundationPipeline fetched a pull request.",
    },
  ];
}

async function untrustedCodeRan(): Promise<boolean> {
  const base = 'export function danger(): void {\n  throw new Error("untrusted-pr-code");\n}\n';
  const head = 'export function danger(): void {\n  throw new Error("untrusted-pr-code-2");\n}\n';
  const pipeline = createFoundationPipeline();
  const parser = createDiffParser();
  const prepared = prepare(
    {
      path: "src/untrusted.ts",
      status: "modified",
      withholdPatch: false,
      base,
      head,
      labels: [],
      cards: [],
    },
    parser,
  );
  try {
    const blocks = await pipeline.findChangedBlocks({
      diffs: pipeline.parseDiffs([prepared.pull]),
      sources: [prepared.source],
    });
    await pipeline.assessBlocks({
      blocks,
      enabledReasons: [],
      provider: standIn([], { inputTokens: 0, outputTokens: 0 }),
      sources: [prepared.source],
    });
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.includes("untrusted-pr-code")) {
      return true;
    }
    throw error;
  }
}
