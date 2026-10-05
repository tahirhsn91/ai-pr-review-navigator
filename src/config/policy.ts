import { z } from "zod";

import { ConfigError } from "../shared/errors.js";
import { ATTENTION_REASONS, PRIORITY_BANDS } from "../shared/vocabulary.js";
import { formatIssues } from "./issues.js";

const languageSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_+#-]*$/u, "Language must be a Tree-sitter grammar name.");

function rejectDuplicates(
  values: readonly string[],
  context: z.RefinementCtx,
  path: string,
  label: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index],
        message: `Duplicate ${label}.`,
      });
      return;
    }
    seen.add(value);
  });
}

export const reviewFocusPolicySchema = z
  .object({
    version: z.literal(1),
    selection: z
      .object({
        maxBlocks: z.number().int().positive().max(100),
        minBand: z.enum(PRIORITY_BANDS),
      })
      .strict(),
    ignore: z.array(z.string().min(1)),
    languages: z.array(languageSchema).nonempty(),
    attention: z.array(z.enum(ATTENTION_REASONS)).nonempty(),
    criticality: z.array(z.string().min(1).max(240)).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    rejectDuplicates(value.languages, context, "languages", "language");
    rejectDuplicates(value.attention, context, "attention", "attention reason");
  });

export type ReviewFocusPolicy = z.infer<typeof reviewFocusPolicySchema>;

export function parseReviewFocusPolicy(input: unknown): ReviewFocusPolicy {
  const parsed = reviewFocusPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(`Invalid review-focus policy. ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}
