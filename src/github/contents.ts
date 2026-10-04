import { z } from "zod";

import { PULL_REQUEST_FILE_STATUSES } from "./types.js";
import type { PullRequestFile } from "./types.js";
import { GitHubRequestError } from "./errors.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/iu, "Expected a 40-character Git SHA.");

export const pullRequestResponseSchema = z
  .object({
    title: z.string(),
    base: z.object({ sha: shaSchema }).passthrough(),
    head: z.object({ sha: shaSchema }).passthrough(),
  })
  .passthrough();

const optionalCount = z.number().int().nonnegative().optional();

export const pullRequestFileResponseSchema = z
  .object({
    filename: z.string().min(1),
    status: z.enum(PULL_REQUEST_FILE_STATUSES),
    patch: z.string().nullable().optional(),
    previous_filename: z.string().nullable().optional(),
    additions: optionalCount,
    deletions: optionalCount,
  })
  .passthrough();

export const pullRequestFilesResponseSchema = z.array(pullRequestFileResponseSchema);

const fileContentsSchema = z
  .object({
    type: z.string(),
    size: z.number().int().nonnegative(),
    encoding: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export function mapPullRequestFile(
  input: z.infer<typeof pullRequestFileResponseSchema>,
): PullRequestFile {
  const patch = normalizeOptionalText(input.patch);
  const previousFilename = normalizeOptionalText(input.previous_filename);
  const file: PullRequestFile = {
    filename: input.filename,
    status: input.status,
    ...(patch === undefined ? {} : { patch }),
    ...(previousFilename === undefined ? {} : { previousFilename }),
    ...(input.additions === undefined ? {} : { additions: input.additions }),
    ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
  };
  return file;
}

export function parseFileContents(
  body: unknown,
  maxFileBytes: number,
):
  | { readonly status: "present"; readonly text: string; readonly byteLength: number }
  | { readonly status: "binary"; readonly byteLength: number }
  | { readonly status: "oversized"; readonly byteLength: number }
  | { readonly status: "unsupported"; readonly reason: string } {
  if (Array.isArray(body)) {
    return { status: "unsupported", reason: "directory" };
  }
  const parsed = fileContentsSchema.safeParse(body);
  if (!parsed.success) {
    throw new GitHubRequestError("GitHub file contents response was invalid.");
  }
  const contents = parsed.data;
  if (contents.type !== "file") {
    return { status: "unsupported", reason: contents.type };
  }
  if (contents.size > maxFileBytes) {
    return { status: "oversized", byteLength: contents.size };
  }
  if (contents.size === 0) {
    return { status: "present", text: "", byteLength: 0 };
  }
  if (contents.encoding !== undefined && contents.encoding !== "base64") {
    throw new GitHubRequestError("GitHub file contents encoding is unsupported.");
  }
  if (contents.content === undefined) {
    throw new GitHubRequestError("GitHub file contents body was missing.");
  }
  const bytes = Buffer.from(contents.content.replace(/\s/gu, ""), "base64");
  if (bytes.length !== contents.size) {
    throw new GitHubRequestError("GitHub file contents size did not match the body.");
  }
  if (bytes.subarray(0, 8000).includes(0)) {
    return { status: "binary", byteLength: contents.size };
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return { status: "binary", byteLength: contents.size };
  }
  return { status: "present", text, byteLength: contents.size };
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) {
    return undefined;
  }
  return value;
}
