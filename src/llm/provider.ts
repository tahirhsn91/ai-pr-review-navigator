import { z } from "zod";

import { LlmRequestError } from "./errors.js";
import {
  assertWithinBudget,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GPT_MODEL,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
} from "./limits.js";
import { postJson, type LlmLogger } from "./transport.js";
import { unimplemented } from "../shared/unimplemented.js";
import type { LlmCompletionRequest, LlmProvider } from "./types.js";

const anthropicResponseSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const openAiResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullable(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export interface LlmProviderOptions {
  readonly provider: "claude" | "gpt";
  readonly apiKey: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: LlmLogger;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxInputTokens?: number;
  readonly maxCostUsd?: number;
}

export function unimplementedExplainAttention(): LlmProvider["explainAttention"] {
  return unimplemented("LlmProvider.explainAttention");
}

export function createLlmProvider(options: LlmProviderOptions): LlmProvider {
  if (options.apiKey.trim().length === 0) {
    throw new LlmRequestError("LLM API key is missing.");
  }
  const model =
    options.model ?? (options.provider === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_GPT_MODEL);
  const explainAttention = unimplementedExplainAttention();
  return {
    provider: options.provider,
    model,
    explainAttention,
    complete(request) {
      return complete(options, model, request);
    },
  };
}

async function complete(
  options: LlmProviderOptions,
  model: string,
  request: LlmCompletionRequest,
): Promise<{ readonly text: string }> {
  const maxOutputTokens = Math.min(request.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assertWithinBudget({
    inputText: `${request.system}\n${request.user}`,
    maxOutputTokens,
    maxInputTokens: options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxCostUsd: options.maxCostUsd ?? DEFAULT_MAX_COST_USD,
  });
  const body =
    options.provider === "claude"
      ? await postClaude(options, model, request, maxOutputTokens)
      : await postOpenAi(options, model, request, maxOutputTokens);
  return { text: body };
}

async function postClaude(
  options: LlmProviderOptions,
  model: string,
  request: LlmCompletionRequest,
  maxOutputTokens: number,
): Promise<string> {
  const payload = await postJson({
    provider: "claude",
    model,
    url: "https://api.anthropic.com/v1/messages",
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    fetchImpl: options.fetch ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    logger: options.logger ?? noopLogger,
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model,
      max_tokens: maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    },
  });
  const parsed = anthropicResponseSchema.safeParse(payload);
  const text = parsed.success
    ? parsed.data.content.find((part) => part.type === "text")?.text
    : undefined;
  if (text === undefined || text.length === 0) {
    throw new LlmRequestError("LLM response shape was invalid.");
  }
  return text;
}

async function postOpenAi(
  options: LlmProviderOptions,
  model: string,
  request: LlmCompletionRequest,
  maxOutputTokens: number,
): Promise<string> {
  const payload = await postJson({
    provider: "gpt",
    model,
    url: "https://api.openai.com/v1/chat/completions",
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    fetchImpl: options.fetch ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    logger: options.logger ?? noopLogger,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: {
      model,
      max_tokens: maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    },
  });
  const parsed = openAiResponseSchema.safeParse(payload);
  const text = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
  if (text === null || text === undefined || text.length === 0) {
    throw new LlmRequestError("LLM response shape was invalid.");
  }
  return text;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function noopLogger(): void {
  return undefined;
}
