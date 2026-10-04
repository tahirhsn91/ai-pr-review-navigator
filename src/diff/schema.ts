import { z } from "zod";

import { PULL_REQUEST_FILE_STATUSES } from "../github/types.js";
import { ReviewNavigatorError } from "../shared/errors.js";
import type { PullRequestDiff } from "./types.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const lineRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.endLine >= range.startLine, "Line range is reversed.");

const diffLineSchema = z
  .object({
    type: z.enum(["context", "add", "delete"]),
    text: z.string(),
    oldLineNumber: z.number().int().positive().optional(),
    newLineNumber: z.number().int().positive().optional(),
  })
  .strict();

const fileSourceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("present"),
      text: z.string(),
      byteLength: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("absent"),
      reason: z.enum(["not_in_base", "not_in_head", "not_found"]),
    })
    .strict(),
  z.object({ status: z.literal("binary"), byteLength: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("oversized"), byteLength: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("unsupported"), reason: z.string().min(1) }).strict(),
]);

export const processedFileChangeSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum(PULL_REQUEST_FILE_STATUSES),
    hunks: z.array(
      z
        .object({
          oldStart: z.number().int().nonnegative(),
          oldLines: z.number().int().nonnegative(),
          newStart: z.number().int().nonnegative(),
          newLines: z.number().int().nonnegative(),
          lines: z.array(diffLineSchema),
        })
        .strict(),
    ),
    addedRanges: z.array(lineRangeSchema),
    removedRanges: z.array(lineRangeSchema),
    patchStatus: z.enum(["parsed", "missing", "invalid", "binary"]),
    lineMappingComplete: z.boolean(),
    baseSha: shaSchema,
    headSha: shaSchema,
    base: fileSourceSchema,
    head: fileSourceSchema,
    indicators: z
      .object({
        binary: z.boolean(),
        generated: z.boolean(),
        oversized: z.boolean(),
        unsupported: z.boolean(),
      })
      .strict(),
    contentComplete: z.boolean(),
    rename: z
      .object({ from: z.string().min(1), to: z.string().min(1) })
      .strict()
      .optional(),
    deletion: z
      .object({ path: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const pullRequestDiffSchema = z
  .object({
    ref: z
      .object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        number: z.number().int().positive(),
      })
      .strict(),
    title: z.string(),
    baseSha: shaSchema,
    headSha: shaSchema,
    files: z.array(processedFileChangeSchema),
    complete: z.boolean(),
  })
  .strict();

export class DiffModelError extends ReviewNavigatorError {
  constructor(message: string) {
    super("diff_model_invalid", message);
  }
}

export function assertPullRequestDiff(value: PullRequestDiff): PullRequestDiff {
  const parsed = pullRequestDiffSchema.safeParse(value);
  if (!parsed.success) {
    throw new DiffModelError("Normalized diff model failed validation.");
  }
  return value;
}
