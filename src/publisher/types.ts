import type { PullRequestRef } from "../github/types.js";
import type { LineRange } from "../shared/location.js";
import type { AttentionReason, PriorityBand } from "../shared/vocabulary.js";

export interface ReviewFocusItem {
  readonly rank: number;
  readonly path: string;
  readonly name: string;
  readonly range: LineRange;
  readonly band: PriorityBand;
  readonly reasons: readonly AttentionReason[];
  readonly explanation?: string;
}

export interface ReviewFocusReport {
  readonly pullRequest: PullRequestRef;
  readonly headSha: string;
  readonly items: readonly ReviewFocusItem[];
  readonly omittedCount: number;
}

export interface PublishReceipt {
  readonly commentId: number;
  readonly url: string;
}

export interface ReviewPublisher {
  publish(report: ReviewFocusReport): Promise<PublishReceipt>;
}
