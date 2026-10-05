import type { LogicalBlock } from "../parser/types.js";
import type { AttentionReason } from "../shared/vocabulary.js";
import { ATTENTION_REASONS } from "../shared/vocabulary.js";
import type { AnalysisPrompt } from "./prompt.js";
import type {
  AnalysisConfidence,
  AttentionSignal,
  BlockAssessment,
  BusinessImpact,
  SemanticAssessment,
} from "./types.js";

const QUALITY_ONLY =
  /\b(readability|code quality|naming|extract method|add comments|style guide|refactor for clarity)\b/iu;

export function guardAssessment(
  model: SemanticAssessment,
  block: LogicalBlock,
  prompt: AnalysisPrompt,
  enabledReasons: readonly AttentionReason[],
): BlockAssessment {
  const reasons = new Set(model.uncertaintyReasons);
  let confidence: AnalysisConfidence = model.confidence;
  let impact: BusinessImpact = model.businessImpact;
  const behaviorChanged = model.behaviorChanged;

  if (prompt.truncated) {
    reasons.add("Supplied source was truncated to the token budget.");
  }
  if (block.confidence === "low" || block.parseStatus !== "parsed") {
    reasons.add("The diff mapping is not reliable enough to treat this assessment as certain.");
    confidence = "low";
  }
  if (citesUnknownLine(model.evidence, block)) {
    reasons.add("Evidence cited a line that is not in the supplied block.");
    confidence = "low";
    impact = "unknown";
  }
  if (!behaviorChanged && QUALITY_ONLY.test(model.reviewReason)) {
    reasons.add("The response described code quality rather than behavior.");
    confidence = "low";
  }
  if (impact === "critical" && !behaviorChanged) {
    reasons.add("A critical impact was reported without a behavior change.");
    confidence = "low";
  }
  if (confidence === "low" && (impact === "none" || impact === "limited" || !behaviorChanged)) {
    if (impact !== "critical") {
      impact = "unknown";
    }
    reasons.add("There is not enough evidence to treat this change as unimportant.");
  }
  if (reasons.size > 0 && confidence === "high") {
    confidence = "medium";
  }
  if (confidence !== "low" && model.evidence.length === 0) {
    confidence = "low";
    impact = impact === "critical" ? impact : "unknown";
    reasons.add("The response did not cite evidence from the supplied block.");
  }

  const uncertaintyReasons = [...reasons].slice(0, 8);
  if (uncertaintyReasons.length > 0 && confidence === "high") {
    confidence = "medium";
  }
  if (confidence === "low" && impact === "none") {
    impact = "unknown";
  }

  return {
    blockId: block.id,
    behaviorChanged,
    businessImpact: impact,
    reviewReason: model.reviewReason,
    evidence: model.evidence,
    contextRequired: model.contextRequired,
    confidence,
    uncertaintyReasons,
    signals: signalsFor(
      model.reviewReason,
      enabledReasons,
      confidence,
      uncertaintyReasons,
      behaviorChanged,
    ),
  };
}

export function unassessedBlock(block: LogicalBlock, reason: string): BlockAssessment {
  return {
    blockId: block.id,
    behaviorChanged: false,
    businessImpact: "unknown",
    reviewReason: "Behavior was not assessed.",
    evidence: [],
    contextRequired: ["Base or head source for this block."],
    confidence: "low",
    uncertaintyReasons: [reason],
    signals: [],
  };
}

function signalsFor(
  reviewReason: string,
  enabledReasons: readonly AttentionReason[],
  confidence: AnalysisConfidence,
  uncertaintyReasons: readonly string[],
  behaviorChanged: boolean,
): AttentionSignal[] {
  if (!behaviorChanged || confidence === "low" || uncertaintyReasons.length > 0) {
    return [];
  }
  const summary = reviewReason.length > 200 ? reviewReason.slice(0, 200) : reviewReason;
  return ATTENTION_REASONS.filter(
    (reason) =>
      enabledReasons.includes(reason) && new RegExp(`\\b${reason}\\b`, "u").test(reviewReason),
  ).map((reason) => ({ reason, summary }));
}

function citesUnknownLine(evidence: readonly string[], block: LogicalBlock): boolean {
  const allowed = new Set<number>();
  addRange(allowed, block.baseRange);
  addRange(allowed, block.headRange);
  for (const changed of block.changedLines) {
    addRange(allowed, changed.range);
  }
  if (allowed.size === 0) {
    return false;
  }
  for (const item of evidence) {
    for (const match of item.matchAll(/\bline\s+(\d+)\b/giu)) {
      const line = Number(match[1]);
      if (!Number.isInteger(line) || !allowed.has(line)) {
        return true;
      }
    }
  }
  return false;
}

function addRange(target: Set<number>, range: { startLine: number; endLine: number } | null): void {
  if (range === null) {
    return;
  }
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    target.add(line);
  }
}
