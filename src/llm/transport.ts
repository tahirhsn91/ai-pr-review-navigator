import { LlmRequestError } from "./errors.js";

const RETRYABLE = new Set([429, 502, 503, 504]);

export interface LlmLogEvent {
  readonly provider: string;
  readonly model: string;
  readonly outcome: "success" | "retry" | "failure";
  readonly attempt: number;
  readonly statusCode: number | null;
}

export type LlmLogger = (event: LlmLogEvent) => void;

export async function postJson(input: {
  readonly provider: string;
  readonly model: string;
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly fetchImpl: typeof fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly logger: LlmLogger;
  readonly headers: Readonly<Record<string, string>>;
}): Promise<unknown> {
  let attempt = 0;
  let lastStatus: number | null = null;
  while (attempt < input.maxAttempts) {
    attempt += 1;
    try {
      const response = await input.fetchImpl(input.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs),
        headers: input.headers,
        body: JSON.stringify(input.body),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.arrayBuffer();
        throw new LlmRequestError("LLM redirect was refused.");
      }
      if (RETRYABLE.has(response.status) && attempt < input.maxAttempts) {
        lastStatus = response.status;
        await response.arrayBuffer();
        input.logger({
          provider: input.provider,
          model: input.model,
          outcome: "retry",
          attempt,
          statusCode: response.status,
        });
        await input.sleep(Math.min(2_000, 250 * attempt));
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        lastStatus = response.status;
        throw new LlmRequestError(`LLM request failed (${response.status}).`);
      }
      input.logger({
        provider: input.provider,
        model: input.model,
        outcome: "success",
        attempt,
        statusCode: response.status,
      });
      return parseBody(text);
    } catch (error) {
      if (error instanceof LlmRequestError && !isRetryableMessage(error.message)) {
        input.logger({
          provider: input.provider,
          model: input.model,
          outcome: "failure",
          attempt,
          statusCode: lastStatus,
        });
        throw new LlmRequestError(redactSecret(error.message, input.apiKey));
      }
      if (attempt >= input.maxAttempts) {
        input.logger({
          provider: input.provider,
          model: input.model,
          outcome: "failure",
          attempt,
          statusCode: lastStatus,
        });
        if (error instanceof LlmRequestError) {
          throw new LlmRequestError(redactSecret(error.message, input.apiKey));
        }
        throw new LlmRequestError(
          redactSecret(
            isAbort(error) ? "LLM request timed out." : "LLM request failed.",
            input.apiKey,
          ),
        );
      }
      input.logger({
        provider: input.provider,
        model: input.model,
        outcome: "retry",
        attempt,
        statusCode: lastStatus,
      });
      await input.sleep(Math.min(2_000, 250 * attempt));
    }
  }
  throw new LlmRequestError("LLM request failed.");
}

export function redactSecret(message: string, secret: string): string {
  const redacted = secret.length > 0 ? message.split(secret).join("[redacted]") : message;
  return redacted.length > 200 ? `${redacted.slice(0, 200)}…` : redacted;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmRequestError("LLM response was not JSON.");
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isRetryableMessage(message: string): boolean {
  return message.startsWith("LLM request failed (429)") || message.includes("timed out");
}
