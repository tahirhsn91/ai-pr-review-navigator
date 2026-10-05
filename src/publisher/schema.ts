import { z } from "zod";

import { PublishError } from "./errors.js";
import { PUBLISHED_GROUPS, PUBLISHED_STATUSES } from "./types.js";
import type { ReviewFocusReport } from "./types.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const lineRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine(
    (range) => range.endLine >= range.startLine,
    "A line range must end at or after its start.",
  );

const itemSchema = z
  .object({
    blockId: z.string().min(1).max(300),
    path: z.string().min(1).max(500),
    name: z.string().min(1).max(300),
    range: lineRangeSchema,
    blockRange: lineRangeSchema,
    side: z.enum(["base", "head"]),
    reviewReason: z.string().min(1).max(500),
    group: z.enum(PUBLISHED_GROUPS),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.range.startLine < item.blockRange.startLine ||
      item.range.endLine > item.blockRange.endLine
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Changed range is outside the logical block.",
      });
    }
  });

export const reviewFocusReportSchema = z
  .object({
    pullRequest: z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
        repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
        number: z.number().int().positive(),
      })
      .strict(),
    baseSha: shaSchema,
    headSha: shaSchema,
    analysisStatus: z.enum(PUBLISHED_STATUSES),
    overflowCount: z.number().int().nonnegative(),
    blocks: z.array(itemSchema).max(200),
  })
  .strict();

export function parseReviewFocusReport(input: ReviewFocusReport): ReviewFocusReport {
  const parsed = reviewFocusReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublishError("Review focus report did not match the publishing schema.");
  }
  return parsed.data;
}
