import type { LogicalBlock } from "../parser/types.js";
import type { AttentionReason } from "../shared/vocabulary.js";

export interface AttentionSignal {
  readonly reason: AttentionReason;
  readonly summary: string;
}

export interface BlockAssessment {
  readonly blockId: string;
  readonly signals: readonly [AttentionSignal, ...AttentionSignal[]];
}

export interface AssessBlocksRequest {
  readonly blocks: readonly LogicalBlock[];
  readonly enabledReasons: readonly AttentionReason[];
}

export interface ReviewFocusAnalyzer {
  assess(input: AssessBlocksRequest): Promise<readonly BlockAssessment[]>;
}
