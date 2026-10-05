import { readFileSync } from "node:fs";

import { PublishError } from "./errors.js";
import { createReviewPublisher } from "./publisher.js";
import type { ReviewFocusReport } from "./types.js";

export async function publishReviewFocusFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const token = required(env, "GITHUB_TOKEN");
  const repository = required(env, "GITHUB_REPOSITORY");
  const pullRequest = required(env, "PUBLISH_PULL_REQUEST");
  const reportPath = required(env, "REVIEW_FOCUS_REPORT");
  const separator = repository.indexOf("/");
  const owner = separator > 0 ? repository.slice(0, separator) : "";
  const repo = separator > 0 ? repository.slice(separator + 1) : "";
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new PublishError("GITHUB_REPOSITORY must be an owner/repo name.");
  }
  if (!/^[1-9]\d*$/u.test(pullRequest)) {
    throw new PublishError("PUBLISH_PULL_REQUEST must be a pull request number.");
  }
  const report = readReport(reportPath, owner, repo, Number(pullRequest));
  const receipt = await createReviewPublisher({ token }).publish(report);
  process.stdout.write(`Published review focus comment ${receipt.commentId}.\n`);
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new PublishError(`${name} is not set.`);
  }
  return value;
}

function readReport(path: string, owner: string, repo: string, number: number): ReviewFocusReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new PublishError("REVIEW_FOCUS_REPORT could not be read.");
  }
  if (!isRecord(parsed)) {
    throw new PublishError("REVIEW_FOCUS_REPORT could not be read.");
  }
  const pullRequest = isRecord(parsed.pullRequest) ? parsed.pullRequest : {};
  return {
    ...(parsed as Omit<ReviewFocusReport, "pullRequest">),
    pullRequest: {
      owner: typeof pullRequest.owner === "string" ? pullRequest.owner : owner,
      repo: typeof pullRequest.repo === "string" ? pullRequest.repo : repo,
      number: typeof pullRequest.number === "number" ? pullRequest.number : number,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
