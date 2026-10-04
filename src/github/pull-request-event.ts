import { readFileSync } from "node:fs";

import type { ZodError } from "zod";
import { z } from "zod";

import { ReviewNavigatorError } from "../shared/errors.js";

export const PULL_REQUEST_EVENT_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
] as const;

export type PullRequestEventAction = (typeof PULL_REQUEST_EVENT_ACTIONS)[number];

export interface PullRequestEventMetadata {
  readonly eventType: PullRequestEventAction;
  readonly number: number;
  readonly baseSha: string;
  readonly headSha: string;
}

const MAX_EVENT_BYTES = 20_000_000;
const shaMessage = "Expected a 40-character Git SHA.";
const actionMessage = "Expected opened, reopened, synchronize, or ready_for_review.";

const shaSchema = z
  .string({ required_error: shaMessage, invalid_type_error: shaMessage })
  .regex(/^[0-9a-f]{40}$/iu, shaMessage);

const pullRequestEventSchema = z
  .object({
    action: z.enum(PULL_REQUEST_EVENT_ACTIONS, {
      errorMap: () => ({ message: actionMessage }),
    }),
    pull_request: z
      .object({
        number: z
          .number({
            required_error: "Expected a positive integer.",
            invalid_type_error: "Expected a positive integer.",
          })
          .int()
          .positive(),
        base: z.object({ sha: shaSchema }).passthrough(),
        head: z.object({ sha: shaSchema }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export class PullRequestEventError extends ReviewNavigatorError {
  constructor(message: string) {
    super("pull_request_event_invalid", message);
  }
}

export function parsePullRequestEventMetadata(input: unknown): PullRequestEventMetadata {
  const parsed = pullRequestEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new PullRequestEventError(`Invalid pull request event. ${formatIssues(parsed.error)}`);
  }
  return {
    eventType: parsed.data.action,
    number: parsed.data.pull_request.number,
    baseSha: parsed.data.pull_request.base.sha.toLowerCase(),
    headSha: parsed.data.pull_request.head.sha.toLowerCase(),
  };
}

export function parsePullRequestEventDocument(
  text: string,
  maxBytes = MAX_EVENT_BYTES,
): PullRequestEventMetadata {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new PullRequestEventError(`Pull request event file exceeds ${maxBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PullRequestEventError("Pull request event file is not valid JSON.");
  }
  return parsePullRequestEventMetadata(parsed);
}

export function readPullRequestEventMetadata(
  eventPath: string | undefined,
): PullRequestEventMetadata {
  if (eventPath === undefined || eventPath.trim() === "") {
    throw new PullRequestEventError("GITHUB_EVENT_PATH is missing.");
  }
  let text: string;
  try {
    text = readFileSync(eventPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      throw new PullRequestEventError(`Pull request event file not found at ${eventPath}.`);
    }
    throw new PullRequestEventError(`Unable to read the pull request event file at ${eventPath}.`);
  }
  return parsePullRequestEventDocument(text);
}

export function formatPullRequestEventReport(metadata: PullRequestEventMetadata): string {
  return [
    "Review Focus pull request metadata",
    `event: ${metadata.eventType}`,
    `number: ${metadata.number}`,
    `base: ${metadata.baseSha}`,
    `head: ${metadata.headSha}`,
  ].join("\n");
}

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
