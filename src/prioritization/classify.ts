import type { BlockAssessment } from "../analysis/types.js";
import type { ReviewFocusPolicy } from "../config/policy.js";
import type { LogicalBlock } from "../parser/types.js";
import type { AttentionReason } from "../shared/vocabulary.js";
import type { ReviewGroup } from "./types.js";

const IMPACT_SCORE = {
  critical: 50,
  significant: 35,
  limited: 15,
  none: 0,
  unknown: 0,
} as const;

const KIND_SCORE: Record<LogicalBlock["kind"], number> = {
  authorization: 30,
  calculation: 24,
  transaction: 22,
  database_call: 18,
  validation: 12,
  exception_handler: 12,
  conditional: 8,
  event_publish: 8,
  return: 6,
  external_call: 6,
  method: 6,
  function: 6,
  class: 4,
  loop: 2,
  unknown: 0,
};

const SIGNAL_SCORE: Record<AttentionReason, number> = {
  security_boundary: 12,
  data_shape: 8,
  control_flow: 6,
  error_handling: 6,
  public_api: 6,
  concurrency: 6,
  wide_span: 3,
  cross_file_coupling: 8,
};

const DATA_KINDS = new Set<LogicalBlock["kind"]>(["calculation", "database_call", "transaction"]);

const FORMATTING =
  /\b(format|formatting|whitespace|indent|indentation|prettier|boilerplate|rename|renamed)\b/iu;

export interface Classification {
  readonly group: ReviewGroup;
  readonly score: number;
  readonly reasons: readonly AttentionReason[];
  readonly contextRequired: readonly string[];
}

export function classifyBlock(input: {
  readonly block: LogicalBlock;
  readonly assessment: BlockAssessment;
  readonly policy: ReviewFocusPolicy;
  readonly callers: readonly string[];
  readonly testsSupplied: boolean;
  readonly relatedTests: number;
}): Classification {
  const reasons = input.assessment.signals
    .map((signal) => signal.reason)
    .filter((reason) => input.policy.attention.includes(reason));
  const group = chooseGroup(input.block, input.assessment, input.policy);
  const contextRequired = [...input.assessment.contextRequired];
  if (
    input.testsSupplied &&
    input.relatedTests === 0 &&
    group === "must_review" &&
    !contextRequired.includes("No related test was supplied for this block.")
  ) {
    contextRequired.push("No related test was supplied for this block.");
  }
  return {
    group,
    score: scoreBlock(input.block, input.assessment, input.policy, input.callers, reasons),
    reasons,
    contextRequired,
  };
}

function chooseGroup(
  block: LogicalBlock,
  assessment: BlockAssessment,
  policy: ReviewFocusPolicy,
): ReviewGroup {
  if (!isReliable(block, assessment)) {
    return "needs_context";
  }
  if (
    !assessment.behaviorChanged &&
    assessment.businessImpact === "none" &&
    assessment.confidence === "high" &&
    assessment.evidence.length > 0
  ) {
    return "low_priority";
  }
  if (
    !assessment.behaviorChanged &&
    assessment.businessImpact === "limited" &&
    assessment.confidence === "high" &&
    assessment.evidence.length > 0 &&
    (block.change === "moved" || FORMATTING.test(assessment.reviewReason))
  ) {
    return "low_priority";
  }
  if (!assessment.behaviorChanged) {
    return "needs_context";
  }

  const critical = matchesCriticality(block, assessment, policy);
  if (block.kind === "loop") {
    if (assessment.businessImpact === "critical" && critical) {
      return "must_review";
    }
    return "review_if_relevant";
  }
  if (
    block.kind === "authorization" &&
    assessment.businessImpact !== "none" &&
    assessment.businessImpact !== "unknown"
  ) {
    return "must_review";
  }
  if (
    DATA_KINDS.has(block.kind) &&
    (assessment.businessImpact === "significant" ||
      assessment.businessImpact === "critical" ||
      (assessment.businessImpact === "limited" && critical))
  ) {
    return "must_review";
  }
  if (assessment.businessImpact === "significant" || assessment.businessImpact === "critical") {
    return "must_review";
  }
  return "review_if_relevant";
}

function isReliable(block: LogicalBlock, assessment: BlockAssessment): boolean {
  return (
    assessment.confidence !== "low" &&
    assessment.uncertaintyReasons.length === 0 &&
    assessment.businessImpact !== "unknown" &&
    assessment.evidence.length > 0 &&
    block.confidence !== "low" &&
    block.parseStatus === "parsed" &&
    (assessment.contextRequired.length === 0 || assessment.confidence === "high")
  );
}

function matchesCriticality(
  block: LogicalBlock,
  assessment: BlockAssessment,
  policy: ReviewFocusPolicy,
): boolean {
  const reason = assessment.reviewReason.toLowerCase();
  const name = block.name.toLowerCase();
  return policy.criticality.some((rule) => {
    const text = rule.toLowerCase();
    if (name.length >= 4 && text.includes(name)) {
      return true;
    }
    if (text.includes(block.kind)) {
      return true;
    }
    return (
      reason.length > 0 &&
      text.split(/[^a-z0-9]+/u).some((token) => token.length >= 6 && reason.includes(token))
    );
  });
}

function scoreBlock(
  block: LogicalBlock,
  assessment: BlockAssessment,
  policy: ReviewFocusPolicy,
  callers: readonly string[],
  reasons: readonly AttentionReason[],
): number {
  let score =
    IMPACT_SCORE[assessment.businessImpact] +
    KIND_SCORE[block.kind] +
    (assessment.behaviorChanged ? 20 : 0);
  score += assessment.confidence === "high" ? 8 : assessment.confidence === "medium" ? 4 : 0;
  score += block.confidence === "high" ? 4 : block.confidence === "medium" ? 2 : 0;
  if (matchesCriticality(block, assessment, policy)) {
    score += 12;
  }
  if (assessment.behaviorChanged && callers.length > 0) {
    score += Math.min(callers.length, 4) * 3;
  }
  for (const reason of reasons) {
    score += SIGNAL_SCORE[reason];
  }
  if (block.kind === "loop" && assessment.businessImpact !== "critical") {
    score = Math.min(score, 40);
  }
  return score;
}
