/** Increasing attention. `low` is first and `high` is last. */
export const PRIORITY_BANDS = ["low", "medium", "high"] as const;

export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export const LLM_PROVIDER_SETTINGS = ["claude", "gpt", "none"] as const;

export type LlmProviderSetting = (typeof LLM_PROVIDER_SETTINGS)[number];

export const ATTENTION_REASONS = [
  "public_api",
  "control_flow",
  "error_handling",
  "data_shape",
  "concurrency",
  "security_boundary",
  "wide_span",
  "cross_file_coupling",
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** Display names for attention reasons. These are glossary labels, not findings. */
export const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  public_api: "Public API shape changed",
  control_flow: "Control flow changed",
  error_handling: "Error handling changed",
  data_shape: "Data shape changed",
  concurrency: "Concurrency or async sequencing changed",
  security_boundary: "Security boundary changed",
  wide_span: "Changed lines cover much of the block",
  cross_file_coupling: "The change reaches across files",
};
