import type { PullRequestRef } from "../github/types.js";
import type { LineRange } from "../shared/location.js";

export const PUBLISHED_GROUPS = [
  "must_review",
  "review_if_relevant",
  "low_priority",
  "needs_context",
] as const;

export type PublishedGroup = (typeof PUBLISHED_GROUPS)[number];

export const PUBLISHED_STATUSES = ["complete", "partial", "unavailable"] as const;

export type PublishedStatus = (typeof PUBLISHED_STATUSES)[number];

export interface ReviewFocusItem {
  readonly blockId: string;
  readonly path: string;
  readonly name: string;
  readonly range: LineRange;
  readonly blockRange: LineRange;
  readonly side: "base" | "head";
  readonly reviewReason: string;
  readonly group: PublishedGroup;
}

export interface ReviewFocusReport {
  readonly pullRequest: PullRequestRef;
  readonly baseSha: string;
  readonly headSha: string;
  readonly analysisStatus: PublishedStatus;
  readonly overflowCount: number;
  readonly blocks: readonly ReviewFocusItem[];
}

export interface PublishReceipt {
  readonly commentId: number;
  readonly url: string;
  readonly updated: boolean;
  readonly inlinePosted: readonly string[];
  readonly inlineUpdated: readonly string[];
  readonly inlineRemoved: readonly string[];
  readonly inlineSummaryOnly: readonly string[];
}

export interface ReviewPublisher {
  publish(report: ReviewFocusReport): Promise<PublishReceipt>;
}
