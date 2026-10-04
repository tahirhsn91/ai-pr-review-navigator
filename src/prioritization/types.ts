import type { BlockAssessment } from "../analysis/types.js";
import type { ReviewFocusPolicy } from "../config/policy.js";
import type { LogicalBlock } from "../parser/types.js";
import type { PriorityBand } from "../shared/vocabulary.js";

/** Higher scores deserve attention sooner. Scoring arrives with the prioritization milestone. */
export interface RankedBlock {
  readonly block: LogicalBlock;
  readonly assessment: BlockAssessment;
  readonly score: number;
  readonly band: PriorityBand;
  readonly rank: number;
}

export interface RankBlocksRequest {
  readonly blocks: readonly LogicalBlock[];
  readonly assessments: readonly BlockAssessment[];
  readonly policy: ReviewFocusPolicy;
}

export interface Prioritizer {
  rank(input: RankBlocksRequest): readonly RankedBlock[];
}
