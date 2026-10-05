import { GITHUB_API_BASE_URL, type GitHubHttpOptions } from "../github/http.js";
import { GitHubRequestError } from "../github/errors.js";
import { unimplemented } from "../shared/unimplemented.js";
import { createCommentClient, type ReviewComment } from "./comments.js";
import { PublishError } from "./errors.js";
import { parseReviewFocusReport } from "./schema.js";
import {
  INCOMPLETE_MARKER,
  readInlineBlockId,
  renderInline,
  renderSummary,
  SUMMARY_MARKER,
} from "./render.js";
import type {
  PublishReceipt,
  ReviewFocusItem,
  ReviewFocusReport,
  ReviewPublisher,
} from "./types.js";

export interface ReviewPublisherOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function createUnimplementedPublisher(): ReviewPublisher {
  return {
    publish: unimplemented("ReviewPublisher.publish"),
  };
}

export function createReviewPublisher(options: ReviewPublisherOptions): ReviewPublisher {
  if (options.token.trim().length === 0) {
    throw new GitHubRequestError("GitHub token is missing.");
  }
  const http: GitHubHttpOptions = {
    token: options.token,
    apiBaseUrl: options.apiBaseUrl ?? GITHUB_API_BASE_URL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
  return {
    async publish(report) {
      return publishReport(parseReviewFocusReport(report), http);
    },
  };
}

async function publishReport(
  report: ReviewFocusReport,
  http: GitHubHttpOptions,
): Promise<PublishReceipt> {
  const comments = createCommentClient({
    owner: report.pullRequest.owner,
    repo: report.pullRequest.repo,
    number: report.pullRequest.number,
    http,
  });
  const summary = await publishSummary(comments, renderSummary(report));
  const inline = await publishInline(comments, report);
  return {
    commentId: summary.comment.id,
    url: summary.comment.url,
    updated: summary.updated,
    ...inline,
  };
}

async function publishSummary(
  comments: ReturnType<typeof createCommentClient>,
  body: string,
): Promise<{ readonly comment: { id: number; url: string }; readonly updated: boolean }> {
  const existing = (await comments.listIssueComments()).filter((comment) =>
    comment.body.includes(SUMMARY_MARKER),
  );
  const first = existing[0];
  if (first === undefined) {
    return { comment: await comments.createIssueComment(body), updated: false };
  }
  const updated = await comments.updateIssueComment(first.id, body);
  for (const extra of existing.slice(1)) {
    await comments.deleteIssueComment(extra.id);
  }
  return { comment: updated, updated: true };
}

async function publishInline(
  comments: ReturnType<typeof createCommentClient>,
  report: ReviewFocusReport,
): Promise<
  Pick<PublishReceipt, "inlinePosted" | "inlineUpdated" | "inlineRemoved" | "inlineSummaryOnly">
> {
  const existing = await comments.listReviewComments();
  const byBlock = new Map<string, ReviewComment[]>();
  const inlineRemoved: string[] = [];
  for (const comment of existing) {
    if (!comment.body.includes("<!-- review-navigator:inline ")) {
      continue;
    }
    const blockId = readInlineBlockId(comment.body);
    if (blockId === undefined) {
      await comments.deleteReviewComment(comment.id);
      inlineRemoved.push("unreadable");
      continue;
    }
    const group = byBlock.get(blockId) ?? [];
    group.push(comment);
    byBlock.set(blockId, group);
  }

  const inlinePosted: string[] = [];
  const inlineUpdated: string[] = [];
  const inlineSummaryOnly: string[] = [];
  for (const block of report.blocks) {
    if (block.group !== "must_review") {
      continue;
    }
    const prior = byBlock.get(block.blockId) ?? [];
    byBlock.delete(block.blockId);
    const outcome = await reconcileBlock(comments, report, block, prior);
    if (outcome === "posted") {
      inlinePosted.push(block.blockId);
    } else if (outcome === "updated") {
      inlineUpdated.push(block.blockId);
    } else {
      inlineSummaryOnly.push(block.blockId);
    }
    if (outcome !== "updated") {
      for (const comment of prior) {
        await comments.deleteReviewComment(comment.id);
        inlineRemoved.push(block.blockId);
      }
    }
  }

  for (const [blockId, prior] of byBlock) {
    for (const comment of prior) {
      await comments.deleteReviewComment(comment.id);
      inlineRemoved.push(blockId);
    }
  }

  return { inlinePosted, inlineUpdated, inlineRemoved, inlineSummaryOnly };
}

async function reconcileBlock(
  comments: ReturnType<typeof createCommentClient>,
  report: ReviewFocusReport,
  block: ReviewFocusItem,
  prior: readonly ReviewComment[],
): Promise<"posted" | "updated" | "summary-only"> {
  const side = block.side === "head" ? "RIGHT" : "LEFT";
  const line = block.range.startLine;
  const match = prior.find(
    (comment) => comment.path === block.path && comment.line === line && comment.side === side,
  );
  const body = renderInline(report, block);
  if (match !== undefined) {
    await comments.updateReviewComment(match.id, body);
    for (const extra of prior) {
      if (extra.id !== match.id) {
        await comments.deleteReviewComment(extra.id);
      }
    }
    return "updated";
  }
  const created = await comments.createReviewComment({
    body,
    commitId: report.headSha,
    path: block.path,
    line,
    side,
  });
  if (!created.posted) {
    return "summary-only";
  }
  return "posted";
}

export async function keepPriorSummary(
  options: ReviewPublisherOptions & {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
): Promise<"preserved" | "absent"> {
  if (options.token.trim().length === 0) {
    throw new GitHubRequestError("GitHub token is missing.");
  }
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(options.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(options.repo) ||
    !Number.isInteger(options.number) ||
    options.number < 1
  ) {
    throw new PublishError("Pull request reference was invalid.");
  }
  const http: GitHubHttpOptions = {
    token: options.token,
    apiBaseUrl: options.apiBaseUrl ?? GITHUB_API_BASE_URL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
  const comments = createCommentClient({
    owner: options.owner,
    repo: options.repo,
    number: options.number,
    http,
  });
  const existing = (await comments.listIssueComments()).filter((comment) =>
    summaryHasBlocks(comment.body),
  );
  const first = existing[0];
  if (first === undefined) {
    return "absent";
  }
  if (!first.body.includes(INCOMPLETE_MARKER)) {
    await comments.updateIssueComment(first.id, withIncompleteNote(first.body));
  }
  return "preserved";
}

function summaryHasBlocks(body: string): boolean {
  return body.includes(SUMMARY_MARKER) && body.includes("**");
}

function withIncompleteNote(body: string): string {
  const markerAt = body.indexOf(SUMMARY_MARKER);
  if (markerAt < 0) {
    return body;
  }
  const note = `\n${INCOMPLETE_MARKER}\nThe latest analysis did not finish. The previous result was kept.`;
  return `${body.slice(0, markerAt + SUMMARY_MARKER.length)}${note}${body.slice(markerAt + SUMMARY_MARKER.length)}`;
}
