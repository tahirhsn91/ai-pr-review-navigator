import { z } from "zod";

import { AnalysisError } from "./errors.js";
import { ANALYSIS_CONFIDENCE, BUSINESS_IMPACTS } from "./types.js";
import type { SemanticAssessment } from "./types.js";

const structuralAssessmentSchema = z
  .object({
    blockId: z.string().min(1).max(300),
    behaviorChanged: z.boolean(),
    businessImpact: z.enum(BUSINESS_IMPACTS),
    reviewReason: z.string().min(1).max(500),
    evidence: z.array(z.string().min(1).max(500)).max(8),
    contextRequired: z.array(z.string().min(1).max(300)).max(8),
    confidence: z.enum(ANALYSIS_CONFIDENCE),
    uncertaintyReasons: z.array(z.string().min(1).max(300)).max(8),
  })
  .strict();

export const semanticAssessmentSchema = structuralAssessmentSchema.superRefine((value, context) => {
  if (value.confidence === "high" && value.uncertaintyReasons.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "High confidence cannot include uncertainty.",
    });
  }
  if (value.confidence !== "low" && value.evidence.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A confident assessment needs evidence.",
    });
  }
  if (value.confidence === "low" && value.businessImpact === "none") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An uncertain assessment cannot be marked unimportant.",
    });
  }
});

export function parseSemanticAssessment(input: unknown): SemanticAssessment {
  const parsed = structuralAssessmentSchema.safeParse(input);
  if (!parsed.success) {
    throw new AnalysisError("Model response did not match the assessment schema.");
  }
  return parsed.data;
}

export function assertGuardedAssessment(input: SemanticAssessment): void {
  const parsed = semanticAssessmentSchema.safeParse(input);
  if (!parsed.success) {
    throw new AnalysisError("Model response did not match the assessment schema.");
  }
}
