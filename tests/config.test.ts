import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, parseEnvironment, parseReviewFocusPolicy } from "../src/config/index.js";
import { ConfigError } from "../src/shared/errors.js";
import { ATTENTION_REASONS } from "../src/shared/vocabulary.js";

const repoRoot = resolve(".");
const validPolicy = {
  version: 1,
  selection: { maxBlocks: 5, minBand: "high" as const },
  ignore: ["**/dist/**"],
  languages: ["typescript"],
  attention: ["public_api" as const],
};

describe("environment", () => {
  it("accepts a token with no LLM provider", () => {
    expect(parseEnvironment({ GITHUB_TOKEN: "test-token" })).toMatchObject({
      GITHUB_TOKEN: "test-token",
      LLM_PROVIDER: "none",
      REVIEW_FOCUS_CONFIG: ".github/review-focus.yml",
    });
  });

  it("requires the API key for the selected provider", () => {
    expect(() => parseEnvironment({ GITHUB_TOKEN: "test-token", LLM_PROVIDER: "claude" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => parseEnvironment({ GITHUB_TOKEN: "test-token", LLM_PROVIDER: "gpt" })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("names the missing variable and leaves the token out of the message", () => {
    expect(() => parseEnvironment({ LLM_PROVIDER: "none" })).toThrow(/GITHUB_TOKEN/);

    let thrown: unknown;
    try {
      parseEnvironment({ GITHUB_TOKEN: "test-token", LLM_PROVIDER: "test-token" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.message).toContain("LLM_PROVIDER");
      expect(thrown.message).not.toContain("test-token");
    }
  });
});

describe("review-focus policy", () => {
  it("rejects an unsupported version and unknown keys", () => {
    expect(() => parseReviewFocusPolicy({ ...validPolicy, version: 2 })).toThrow(ConfigError);
    expect(() => parseReviewFocusPolicy({ ...validPolicy, extra: true })).toThrow(/extra/);
  });

  it("rejects duplicate languages and attention reasons", () => {
    expect(() =>
      parseReviewFocusPolicy({
        ...validPolicy,
        languages: ["typescript", "typescript"],
      }),
    ).toThrow(/Duplicate language/);
    expect(() =>
      parseReviewFocusPolicy({
        ...validPolicy,
        attention: ["public_api", "public_api"],
      }),
    ).toThrow(/Duplicate attention reason/);
  });
});

describe("loadConfig", () => {
  it("loads the repository policy without merging process.env", () => {
    const config = loadConfig({
      cwd: repoRoot,
      env: {
        GITHUB_TOKEN: "test-token",
        LLM_PROVIDER: "none",
        OPENAI_API_KEY: "test-openai",
      },
    });

    expect(config.policyPath).toBe(resolve(repoRoot, ".github/review-focus.yml"));
    expect(config.githubToken).toBe("test-token");
    expect(config.llmProvider).toBe("none");
    expect(config.policy.version).toBe(1);
    expect(config.policy.selection).toEqual({ maxBlocks: 12, minBand: "medium" });
    expect(config.policy.languages).toEqual(["typescript", "javascript"]);
    expect(config.policy.attention).toEqual([...ATTENTION_REASONS]);
    expect(JSON.stringify(config)).not.toContain("test-openai");
  });

  it("keeps the selected provider key and optional model", () => {
    const config = loadConfig({
      cwd: repoRoot,
      env: {
        GITHUB_TOKEN: "test-token",
        LLM_PROVIDER: "claude",
        ANTHROPIC_API_KEY: "test-anthropic",
        LLM_MODEL: "claude-test",
      },
    });

    expect(config).toMatchObject({
      llmProvider: "claude",
      llmApiKey: "test-anthropic",
      llmModel: "claude-test",
    });
  });

  it("fails when the policy file is missing, invalid, or too large", () => {
    const directory = mkdtempSync(join(tmpdir(), "review-navigator-"));
    const env = { GITHUB_TOKEN: "test-token", LLM_PROVIDER: "none" };
    try {
      expect(() =>
        loadConfig({
          cwd: directory,
          env: { ...env, REVIEW_FOCUS_CONFIG: "missing.yml" },
        }),
      ).toThrow(/not found/);

      writeFileSync(join(directory, "broken.yml"), "version: [\n", "utf8");
      expect(() =>
        loadConfig({
          cwd: directory,
          env: { ...env, REVIEW_FOCUS_CONFIG: "broken.yml" },
        }),
      ).toThrow(ConfigError);

      writeFileSync(join(directory, "large.yml"), `version: ${"1".repeat(70_000)}\n`, "utf8");
      expect(() =>
        loadConfig({
          cwd: directory,
          env: { ...env, REVIEW_FOCUS_CONFIG: "large.yml" },
        }),
      ).toThrow(/exceeds 65536 bytes/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
