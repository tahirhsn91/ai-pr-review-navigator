import { LlmLimitError } from "./errors.js";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";
export const DEFAULT_GPT_MODEL = "gpt-4.1";
export const DEFAULT_MAX_INPUT_TOKENS = 3_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 600;
export const DEFAULT_MAX_COST_USD = 0.05;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

const INPUT_USD_PER_MILLION = 3;
const OUTPUT_USD_PER_MILLION = 15;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function assertWithinBudget(input: {
  readonly inputText: string;
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
  readonly maxCostUsd: number;
}): number {
  const inputTokens = estimateTokens(input.inputText);
  if (inputTokens > input.maxInputTokens) {
    throw new LlmLimitError("LLM input exceeds the token budget.");
  }
  const cost =
    (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
    (input.maxOutputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION;
  if (cost > input.maxCostUsd) {
    throw new LlmLimitError("LLM request exceeds the cost budget.");
  }
  return inputTokens;
}
