import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { parse } from "yaml";

import { ConfigError } from "../shared/errors.js";
import type { LlmProviderSetting } from "../shared/vocabulary.js";
import { environmentSchema, type EnvironmentConfig } from "./environment.js";
import { formatIssues } from "./issues.js";
import { parseReviewFocusPolicy, type ReviewFocusPolicy } from "./policy.js";

const MAX_POLICY_BYTES = 65_536;

export interface LoadConfigOptions {
  /** When set, this object is the whole environment. `process.env` is not merged in. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

interface AppConfigBase {
  readonly policyPath: string;
  readonly policy: ReviewFocusPolicy;
  readonly githubToken: string;
}

interface ProviderConfig {
  readonly llmProvider: "claude" | "gpt";
  readonly llmApiKey: string;
  readonly llmModel?: string;
}

type LlmSelection = { readonly llmProvider: "none" } | ProviderConfig;

export type AppConfig =
  (AppConfigBase & { readonly llmProvider: "none" }) | (AppConfigBase & ProviderConfig);

export function parseEnvironment(env: NodeJS.ProcessEnv): EnvironmentConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment. ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const environment = parseEnvironment(options.env ?? process.env);
  const policyPath = isAbsolute(environment.REVIEW_FOCUS_CONFIG)
    ? environment.REVIEW_FOCUS_CONFIG
    : resolve(cwd, environment.REVIEW_FOCUS_CONFIG);
  const policy = parseReviewFocusPolicy(readPolicyDocument(policyPath));
  return toAppConfig(environment, policyPath, policy);
}

function readPolicyDocument(policyPath: string): unknown {
  const text = readPolicyText(policyPath);
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES) {
    throw new ConfigError(
      `Review-focus policy file at ${policyPath} exceeds ${MAX_POLICY_BYTES} bytes.`,
    );
  }
  try {
    return parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to parse YAML.";
    throw new ConfigError(`Invalid review-focus policy file at ${policyPath}. ${detail}`);
  }
}

function readPolicyText(policyPath: string): string {
  try {
    return readFileSync(policyPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      throw new ConfigError(`Review-focus policy file not found at ${policyPath}.`);
    }
    throw new ConfigError(`Unable to read review-focus policy file at ${policyPath}.`);
  }
}

function toAppConfig(
  environment: EnvironmentConfig,
  policyPath: string,
  policy: ReviewFocusPolicy,
): AppConfig {
  const llm = llmConfig(environment);
  if (llm.llmProvider === "none") {
    return {
      policyPath,
      policy,
      githubToken: environment.GITHUB_TOKEN,
      llmProvider: "none",
    };
  }
  const configured = {
    policyPath,
    policy,
    githubToken: environment.GITHUB_TOKEN,
    llmProvider: llm.llmProvider,
    llmApiKey: llm.llmApiKey,
  };
  if (llm.llmModel === undefined) {
    return configured;
  }
  return { ...configured, llmModel: llm.llmModel };
}

function llmConfig(environment: EnvironmentConfig): LlmSelection {
  if (environment.LLM_PROVIDER === "none") {
    return { llmProvider: "none" };
  }
  const llmApiKey = apiKey(environment.LLM_PROVIDER, environment);
  const configured = {
    llmProvider: environment.LLM_PROVIDER,
    llmApiKey,
  };
  if (environment.LLM_MODEL === undefined) {
    return configured;
  }
  return { ...configured, llmModel: environment.LLM_MODEL };
}

function apiKey(
  provider: Exclude<LlmProviderSetting, "none">,
  environment: EnvironmentConfig,
): string {
  const key = provider === "claude" ? environment.ANTHROPIC_API_KEY : environment.OPENAI_API_KEY;
  if (key === undefined) {
    throw new ConfigError(
      `Invalid environment. ${provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} is missing.`,
    );
  }
  return key;
}
