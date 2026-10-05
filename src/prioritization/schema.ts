import { z } from "zod";

import { BUSINESS_IMPACTS, ANALYSIS_CONFIDENCE } from "../analysis/types.js";
import { LOGICAL_BLOCK_KINDS } from "../parser/types.js";
import { ATTENTION_REASONS, PRIORITY_BANDS } from "../shared/vocabulary.js";
import { PrioritizationError } from "./errors.js";
import { ANALYSIS_STATUSES, REVIEW_GROUPS } from "./types.js";
import type { FocusReport } from "./types.js";

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

const rankedBlockSchema = z
  .object({
    blockId: z.string().min(1),
    path: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(LOGICAL_BLOCK_KINDS),
    group: z.enum(REVIEW_GROUPS),
    band: z.enum(PRIORITY_BANDS),
    rank: z.number().int().positive(),
    score: z.number().int().nonnegative(),
    side: z.enum(["base", "head"]),
    range: lineRangeSchema,
    blockRange: lineRangeSchema,
    reviewReason: z.string().min(1),
    evidence: z.array(z.string().min(1)),
    reasons: z.array(z.enum(ATTENTION_REASONS)),
    confidence: z.enum(ANALYSIS_CONFIDENCE),
    uncertaintyReasons: z.array(z.string().min(1)),
    contextRequired: z.array(z.string().min(1)),
    behaviorChanged: z.boolean(),
    businessImpact: z.enum(BUSINESS_IMPACTS),
  })
  .strict()
  .superRefine((block, context) => {
    if (
      block.range.startLine < block.blockRange.startLine ||
      block.range.endLine > block.blockRange.endLine
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Selected range is outside the logical block.",
      });
    }
    if (block.group === "low_priority" && block.confidence === "low") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An uncertain block cannot be low priority.",
      });
    }
    if (block.group === "low_priority" && block.businessImpact === "unknown") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An unknown impact cannot be low priority.",
      });
    }
    if (block.group === "must_review" && block.uncertaintyReasons.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A must-review block cannot carry uncertainty.",
      });
    }
  });

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const focusReportSchema = z
  .object({
    baseSha: shaSchema,
    headSha: shaSchema,
    analysisStatus: z.enum(ANALYSIS_STATUSES),
    groups: z
      .object({
        mustReview: z.array(rankedBlockSchema),
        reviewIfRelevant: z.array(rankedBlockSchema),
        lowPriority: z.array(rankedBlockSchema),
        needsContext: z.array(rankedBlockSchema),
      })
      .strict(),
    displayed: z.array(rankedBlockSchema),
    overflow: z.array(rankedBlockSchema),
    counts: z
      .object({
        candidates: z.number().int().nonnegative(),
        selected: z.number().int().nonnegative(),
        displayed: z.number().int().nonnegative(),
        overflow: z.number().int().nonnegative(),
        hiddenLowPriority: z.number().int().nonnegative(),
        merged: z.number().int().nonnegative(),
        duplicatesRemoved: z.number().int().nonnegative(),
        excludedWithoutChanges: z.number().int().nonnegative(),
        excludedWithoutLocation: z.number().int().nonnegative(),
      })
      .strict(),
    deduplication: z
      .object({
        merged: z.array(
          z
            .object({
              kept: z.string().min(1),
              absorbed: z.array(z.string().min(1)),
            })
            .strict(),
        ),
        duplicatesRemoved: z.array(z.string().min(1)),
        expanded: z.array(
          z
            .object({
              from: z.string().min(1),
              to: z.string().min(1),
            })
            .strict(),
        ),
        unmatchedAssessments: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export function parseFocusReport(input: FocusReport): FocusReport {
  const parsed = focusReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new PrioritizationError("Prioritization report did not match the selection schema.");
  }
  return parsed.data;
}
