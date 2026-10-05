import type { BlockAssessment } from "../analysis/types.js";
import type { ReviewFocusPolicy } from "../config/policy.js";
import type { LogicalBlock } from "../parser/types.js";
import type { LineRange } from "../shared/location.js";
import type { AttentionReason, PriorityBand } from "../shared/vocabulary.js";

export const REVIEW_GROUPS = [
  "must_review",
  "review_if_relevant",
  "low_priority",
  "needs_context",
] as const;

export type ReviewGroup = (typeof REVIEW_GROUPS)[number];

export const ANALYSIS_STATUSES = ["complete", "partial", "unavailable"] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export interface TestEvidence {
  readonly path: string;
  readonly relatedBlockIds: readonly string[];
  readonly behaviorChanged: boolean;
}

export interface DependencyImpact {
  readonly blockId: string;
  readonly callers: readonly string[];
  readonly callees: readonly string[];
}

export interface RankBlocksRequest {
  readonly baseSha: string;
  readonly headSha: string;
  readonly blocks: readonly LogicalBlock[];
  readonly assessments: readonly BlockAssessment[];
  readonly policy: ReviewFocusPolicy;
  readonly tests?: readonly TestEvidence[];
  readonly dependencies?: readonly DependencyImpact[];
}

/** One selected block after deduplication. Scoring is deterministic. */
export interface RankedBlock {
  readonly blockId: string;
  readonly path: string;
  readonly name: string;
  readonly kind: LogicalBlock["kind"];
  readonly group: ReviewGroup;
  readonly band: PriorityBand;
  readonly rank: number;
  readonly score: number;
  readonly side: "base" | "head";
  readonly range: LineRange;
  readonly blockRange: LineRange;
  readonly reviewReason: string;
  readonly evidence: readonly string[];
  readonly reasons: readonly AttentionReason[];
  readonly confidence: BlockAssessment["confidence"];
  readonly uncertaintyReasons: readonly string[];
  readonly contextRequired: readonly string[];
  readonly behaviorChanged: boolean;
  readonly businessImpact: BlockAssessment["businessImpact"];
}

export interface FocusGroups {
  readonly mustReview: readonly RankedBlock[];
  readonly reviewIfRelevant: readonly RankedBlock[];
  readonly lowPriority: readonly RankedBlock[];
  readonly needsContext: readonly RankedBlock[];
}

export interface FocusDeduplication {
  readonly merged: readonly { readonly kept: string; readonly absorbed: readonly string[] }[];
  readonly duplicatesRemoved: readonly string[];
  readonly expanded: readonly { readonly from: string; readonly to: string }[];
  readonly unmatchedAssessments: readonly string[];
}

export interface FocusCounts {
  readonly candidates: number;
  readonly selected: number;
  readonly displayed: number;
  readonly overflow: number;
  readonly hiddenLowPriority: number;
  readonly merged: number;
  readonly duplicatesRemoved: number;
  readonly excludedWithoutChanges: number;
  readonly excludedWithoutLocation: number;
}

export interface FocusReport {
  readonly baseSha: string;
  readonly headSha: string;
  readonly analysisStatus: AnalysisStatus;
  readonly groups: FocusGroups;
  readonly displayed: readonly RankedBlock[];
  readonly overflow: readonly RankedBlock[];
  readonly counts: FocusCounts;
  readonly deduplication: FocusDeduplication;
}

export interface Prioritizer {
  rank(input: RankBlocksRequest): FocusReport;
}
