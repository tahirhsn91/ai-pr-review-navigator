import { describe, expect, it } from "vitest";

import { createLlmProvider } from "../src/llm/provider.js";
import { LlmLimitError, LlmRequestError } from "../src/llm/errors.js";
import type { LlmLogEvent } from "../src/llm/transport.js";
import { NotImplementedError } from "../src/shared/errors.js";

const apiKey = ["test", "key", "value"].join("-");

function claudeBody(text: string): string {
  return JSON.stringify({
    content: [{ type: "text", text }],
    usage: { input_tokens: 12, output_tokens: 8 },
  });
}

function gptBody(text: string): string {
  return JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("llm provider", () => {
  it("reads a Claude completion without logging the key or the source", async () => {
    const events: LlmLogEvent[] = [];
    const provider = createLlmProvider({
      provider: "claude",
      apiKey,
      fetch: (_input, _init) =>
        Promise.resolve(new Response(claudeBody('{"blockId":"block-1"}'), { status: 200 })),
      logger: (event) => {
        events.push(event);
      },
      sleep: () => Promise.resolve(),
    });
    const completion = await provider.complete({
      system: "assess behavior",
      user: "SOURCE_SENTINEL",
      maxOutputTokens: 200,
    });
    expect(completion.text).toContain("block-1");
    expect(provider.model).toBe("claude-sonnet-4-5");
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("SOURCE_SENTINEL");
    expect(events[0]).toMatchObject({ provider: "claude", outcome: "success", statusCode: 200 });
  });

  it("reads a GPT completion from the chat completions response", async () => {
    const provider = createLlmProvider({
      provider: "gpt",
      apiKey,
      model: "gpt-test",
      fetch: (input) => {
        expect(requestUrl(input)).toBe("https://api.openai.com/v1/chat/completions");
        return Promise.resolve(new Response(gptBody('{"ok":true}'), { status: 200 }));
      },
      sleep: () => Promise.resolve(),
    });
    const completion = await provider.complete({
      system: "assess behavior",
      user: "changed block",
      maxOutputTokens: 200,
    });
    expect(completion.text).toContain("ok");
    expect(provider.model).toBe("gpt-test");
  });

  it("retries a transient failure and then returns the completion", async () => {
    let calls = 0;
    const delays: number[] = [];
    const provider = createLlmProvider({
      provider: "claude",
      apiKey,
      fetch: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(new Response("busy", { status: 503 }));
        }
        return Promise.resolve(new Response(claudeBody('{"blockId":"block-1"}'), { status: 200 }));
      },
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });
    const completion = await provider.complete({
      system: "assess behavior",
      user: "changed block",
      maxOutputTokens: 200,
    });
    expect(completion.text).toContain("block-1");
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });

  it("stops after the timeout budget", async () => {
    let calls = 0;
    const provider = createLlmProvider({
      provider: "claude",
      apiKey,
      timeoutMs: 20,
      maxAttempts: 2,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("missing signal"));
            return;
          }
          const fail = (): void => {
            const error = new Error("aborted");
            error.name = "TimeoutError";
            reject(error);
          };
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
        }),
      sleep: () => Promise.resolve(),
    });
    await expect(
      provider.complete({ system: "assess behavior", user: "changed block", maxOutputTokens: 200 }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toBe(2);
  });

  it("leaves an authentication failure body out of the error", async () => {
    const provider = createLlmProvider({
      provider: "claude",
      apiKey,
      maxAttempts: 1,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: apiKey }), { status: 401 })),
      sleep: () => Promise.resolve(),
    });
    const error = await provider
      .complete({ system: "assess behavior", user: "changed block", maxOutputTokens: 200 })
      .then(() => {
        throw new Error("expected a failure");
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmRequestError);
    if (error instanceof Error) {
      expect(error.message).not.toContain(apiKey);
    }
  });

  it("refuses to follow a redirect", async () => {
    const provider = createLlmProvider({
      provider: "gpt",
      apiKey,
      maxAttempts: 1,
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/collect" },
          }),
        ),
      sleep: () => Promise.resolve(),
    });
    await expect(
      provider.complete({ system: "assess behavior", user: "changed block", maxOutputTokens: 200 }),
    ).rejects.toThrow(/redirect was refused/);
  });

  it("rejects an oversized prompt before calling the provider", async () => {
    let calls = 0;
    const provider = createLlmProvider({
      provider: "claude",
      apiKey,
      maxInputTokens: 10,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(claudeBody("{}"), { status: 200 }));
      },
      sleep: () => Promise.resolve(),
    });
    await expect(
      provider.complete({
        system: "assess behavior",
        user: "x".repeat(80),
        maxOutputTokens: 100,
      }),
    ).rejects.toBeInstanceOf(LlmLimitError);
    expect(calls).toBe(0);
  });

  it("rejects a blank API key", () => {
    expect(() => createLlmProvider({ provider: "claude", apiKey: "  " })).toThrow(LlmRequestError);
  });

  it("leaves explanations unimplemented", async () => {
    const provider = createLlmProvider({
      provider: "claude",
      apiKey,
      fetch: () => Promise.resolve(new Response(claudeBody("{}"), { status: 200 })),
      sleep: () => Promise.resolve(),
    });
    await expect(
      provider.explainAttention({
        path: "src/billing.ts",
        blockName: "capture",
        language: "typescript",
        reasons: ["public_api"],
        excerpt: "return amount;",
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
