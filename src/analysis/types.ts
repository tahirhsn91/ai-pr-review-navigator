import type { LogicalBlock, SourceFile } from "../parser/types.js";
import type { AttentionReason } from "../shared/vocabulary.js";

export const BUSINESS_IMPACTS = ["unknown", "none", "limited", "significant", "critical"] as const;

export type BusinessImpact = (typeof BUSINESS_IMPACTS)[number];

export const ANALYSIS_CONFIDENCE = ["low", "medium", "high"] as const;

export type AnalysisConfidence = (typeof ANALYSIS_CONFIDENCE)[number];

export interface AttentionSignal {
  readonly reason: AttentionReason;
  readonly summary: string;
}

export interface SemanticAssessment {
  readonly blockId: string;
  readonly behaviorChanged: boolean;
  readonly businessImpact: BusinessImpact;
  readonly reviewReason: string;
  readonly evidence: readonly string[];
  readonly contextRequired: readonly string[];
  readonly confidence: AnalysisConfidence;
  readonly uncertaintyReasons: readonly string[];
}

export interface BlockAssessment extends SemanticAssessment {
  readonly signals: readonly AttentionSignal[];
}

export interface SemanticModel {
  complete(request: {
    readonly system: string;
    readonly user: string;
    readonly maxOutputTokens: number;
  }): Promise<{ readonly text: string }>;
}

export interface AssessBlocksRequest {
  readonly blocks: readonly LogicalBlock[];
  readonly enabledReasons: readonly AttentionReason[];
  readonly provider?: SemanticModel;
  readonly sources?: readonly SourceFile[];
  readonly callers?: readonly string[];
  readonly callees?: readonly string[];
  readonly tests?: readonly string[];
  readonly businessCriticality?: readonly string[];
}

export interface ReviewFocusAnalyzer {
  assess(input: AssessBlocksRequest): Promise<readonly BlockAssessment[]>;
}
