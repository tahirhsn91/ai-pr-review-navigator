import { z } from "zod";

import { LLM_PROVIDER_SETTINGS } from "../shared/vocabulary.js";

const hiddenValueMessage = "Expected a non-empty string.";

function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const requiredText = z.preprocess(
  blankToUndefined,
  z
    .string({
      required_error: hiddenValueMessage,
      invalid_type_error: hiddenValueMessage,
    })
    .min(1, hiddenValueMessage),
);

const optionalText = z.preprocess(
  blankToUndefined,
  z.string().min(1, hiddenValueMessage).optional(),
);

export const environmentSchema = z
  .object({
    GITHUB_TOKEN: requiredText,
    LLM_PROVIDER: z.preprocess(
      blankToUndefined,
      z
        .enum(LLM_PROVIDER_SETTINGS, {
          errorMap: () => ({ message: "Expected claude, gpt, or none." }),
        })
        .default("none"),
    ),
    LLM_MODEL: optionalText,
    ANTHROPIC_API_KEY: optionalText,
    OPENAI_API_KEY: optionalText,
    REVIEW_FOCUS_CONFIG: z.preprocess(
      blankToUndefined,
      z.string().min(1, hiddenValueMessage).default(".github/review-focus.yml"),
    ),
  })
  .superRefine((value, context) => {
    if (value.LLM_PROVIDER === "claude" && value.ANTHROPIC_API_KEY === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER is claude.",
      });
    }
    if (value.LLM_PROVIDER === "gpt" && value.OPENAI_API_KEY === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is required when LLM_PROVIDER is gpt.",
      });
    }
  });

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
