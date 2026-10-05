import type { AttentionReason } from "../shared/vocabulary.js";

export interface ExplainAttentionRequest {
  readonly path: string;
  readonly blockName: string;
  readonly language: string;
  readonly reasons: readonly AttentionReason[];
  readonly excerpt: string;
}

export interface AttentionExplanation {
  readonly text: string;
  readonly provider: "claude" | "gpt";
  readonly model: string;
}

export interface LlmCompletionRequest {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
}

export interface LlmCompletion {
  readonly text: string;
}

export interface LlmProvider {
  readonly provider: "claude" | "gpt";
  readonly model: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
  explainAttention(request: ExplainAttentionRequest): Promise<AttentionExplanation>;
}
