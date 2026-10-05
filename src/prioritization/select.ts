import type { BlockAssessment } from "../analysis/types.js";
import type { LogicalBlock } from "../parser/types.js";
import type { LineRange } from "../shared/location.js";
import type { PriorityBand } from "../shared/vocabulary.js";
import { classifyBlock } from "./classify.js";
import type { Classification } from "./classify.js";
import type { FocusReport, RankBlocksRequest, RankedBlock, ReviewGroup } from "./types.js";

interface Candidate {
  block: LogicalBlock;
  assessment: BlockAssessment;
  classification: Classification;
  side: "base" | "head";
  range: LineRange;
  blockRange: LineRange;
  evidence: string[];
  uncertaintyReasons: string[];
}

const GROUP_ORDER: Record<ReviewGroup, number> = {
  must_review: 0,
  review_if_relevant: 1,
  needs_context: 2,
  low_priority: 3,
};

const SPECIFICITY: readonly LogicalBlock["kind"][] = [
  "authorization",
  "calculation",
  "transaction",
  "database_call",
  "validation",
  "exception_handler",
  "conditional",
  "return",
  "event_publish",
  "external_call",
  "loop",
  "method",
  "function",
  "class",
  "unknown",
];

const BAND_RANK: Record<PriorityBand, number> = { low: 0, medium: 1, high: 2 };

export function selectFocus(input: RankBlocksRequest): Omit<FocusReport, "baseSha" | "headSha"> {
  const assessments = new Map<string, BlockAssessment>();
  const unmatchedAssessments: string[] = [];
  for (const assessment of input.assessments) {
    if (!input.blocks.some((block) => block.id === assessment.blockId)) {
      unmatchedAssessments.push(assessment.blockId);
    }
  }
  for (const assessment of input.assessments) {
    if (!assessments.has(assessment.blockId)) {
      assessments.set(assessment.blockId, assessment);
    }
  }

  const callersFor = new Map(
    (input.dependencies ?? []).map((item) => [item.blockId, item.callers] as const),
  );
  const testsSupplied = input.tests !== undefined;
  let excludedWithoutChanges = 0;
  let excludedWithoutLocation = 0;
  const candidates: Candidate[] = [];

  for (const block of input.blocks) {
    if (block.changedLines.length === 0) {
      excludedWithoutChanges += 1;
      continue;
    }
    const located = locate(block);
    if (located === null) {
      excludedWithoutLocation += 1;
      continue;
    }
    const assessment = assessments.get(block.id) ?? unassessed(block.id);
    const classification = classifyBlock({
      block,
      assessment,
      policy: input.policy,
      callers: callersFor.get(block.id) ?? [],
      testsSupplied,
      relatedTests: relatedTestCount(input.tests ?? [], block.id),
    });
    candidates.push({
      ...located,
      assessment,
      classification,
      evidence: [...assessment.evidence],
      uncertaintyReasons: [...assessment.uncertaintyReasons],
    });
  }

  const deduped = dedupe(candidates);
  const ranked = order(deduped.kept);
  const groups = {
    mustReview: ranked.filter((item) => item.group === "must_review"),
    reviewIfRelevant: ranked.filter((item) => item.group === "review_if_relevant"),
    lowPriority: ranked.filter((item) => item.group === "low_priority"),
    needsContext: ranked.filter((item) => item.group === "needs_context"),
  };
  const eligible = ranked.filter((item) =>
    passesMinBand(item.group, input.policy.selection.minBand),
  );
  const displayed = eligible.slice(0, input.policy.selection.maxBlocks);
  const displayedIds = new Set(displayed.map((item) => item.blockId));
  const overflow = eligible.filter(
    (item) => item.group !== "low_priority" && !displayedIds.has(item.blockId),
  );
  const hiddenLowPriority = ranked.filter(
    (item) => item.group === "low_priority" && !displayedIds.has(item.blockId),
  ).length;

  return {
    analysisStatus: analysisStatus(input.blocks, input.assessments, ranked),
    groups,
    displayed,
    overflow,
    counts: {
      candidates: input.blocks.length,
      selected: ranked.length,
      displayed: displayed.length,
      overflow: overflow.length,
      hiddenLowPriority,
      merged: deduped.merged.reduce((total, item) => total + item.absorbed.length, 0),
      duplicatesRemoved: deduped.duplicatesRemoved.length,
      excludedWithoutChanges,
      excludedWithoutLocation,
    },
    deduplication: {
      merged: deduped.merged,
      duplicatesRemoved: deduped.duplicatesRemoved,
      expanded: deduped.expanded,
      unmatchedAssessments,
    },
  };
}

function locate(
  block: LogicalBlock,
): Pick<Candidate, "block" | "side" | "range" | "blockRange"> | null {
  const head = span(
    block.changedLines.filter((line) => line.side === "head").map((line) => line.range),
  );
  const base = span(
    block.changedLines.filter((line) => line.side === "base").map((line) => line.range),
  );
  const headLocation = place(block, "head", head, block.headRange);
  if (headLocation !== null) {
    return headLocation;
  }
  return place(block, "base", base, block.baseRange);
}

function place(
  block: LogicalBlock,
  side: "base" | "head",
  changed: LineRange | null,
  blockRange: LineRange | null,
): Pick<Candidate, "block" | "side" | "range" | "blockRange"> | null {
  if (changed === null || blockRange === null) {
    return null;
  }
  const range = intersection(changed, blockRange);
  if (range === null) {
    return null;
  }
  return { block, side, range, blockRange };
}

function dedupe(candidates: Candidate[]): {
  kept: Candidate[];
  merged: { kept: string; absorbed: string[] }[];
  duplicatesRemoved: string[];
  expanded: { from: string; to: string }[];
} {
  candidates.sort((left, right) =>
    left.block.id < right.block.id ? -1 : left.block.id > right.block.id ? 1 : 0,
  );
  const dropped = new Set<string>();
  const merged: { kept: string; absorbed: string[] }[] = [];
  const duplicatesRemoved: string[] = [];
  const expanded: { from: string; to: string }[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    const active = candidates.filter((candidate) => !dropped.has(candidate.block.id));
    for (let index = 0; index < active.length; index += 1) {
      const left = active[index];
      if (left === undefined) {
        continue;
      }
      for (let other = index + 1; other < active.length; other += 1) {
        const right = active[other];
        if (right === undefined || !overlaps(left, right)) {
          continue;
        }
        const decision = decide(left, right);
        dropped.add(decision.drop.block.id);
        if (decision.kind === "merge") {
          decision.keep.range = union(decision.keep.range, decision.drop.range);
          decision.keep.blockRange = union(decision.keep.blockRange, decision.drop.blockRange);
          decision.keep.evidence = unique([...decision.keep.evidence, ...decision.drop.evidence]);
          decision.keep.uncertaintyReasons = unique([
            ...decision.keep.uncertaintyReasons,
            ...decision.drop.uncertaintyReasons,
          ]);
          decision.keep.classification = {
            ...decision.keep.classification,
            group: combinedGroup(
              decision.keep.classification.group,
              decision.drop.classification.group,
            ),
            contextRequired: unique([
              ...decision.keep.classification.contextRequired,
              ...decision.drop.classification.contextRequired,
            ]),
          };
          merged.push({ kept: decision.keep.block.id, absorbed: [decision.drop.block.id] });
        } else if (decision.kind === "expand") {
          expanded.push({ from: decision.drop.block.id, to: decision.keep.block.id });
        } else {
          duplicatesRemoved.push(decision.drop.block.id);
        }
        progressed = true;
        break;
      }
      if (progressed) {
        break;
      }
    }
  }
  return {
    kept: candidates.filter((candidate) => !dropped.has(candidate.block.id)),
    merged,
    duplicatesRemoved,
    expanded,
  };
}

function decide(
  left: Candidate,
  right: Candidate,
): {
  keep: Candidate;
  drop: Candidate;
  kind: "duplicate" | "expand" | "merge";
} {
  const equal = sameRange(left.range, right.range);
  const leftContains = contains(left.range, right.range);
  const rightContains = contains(right.range, left.range);
  if (!equal && !leftContains && !rightContains) {
    const keep = prefer(left, right);
    return { keep, drop: keep === left ? right : left, kind: "merge" };
  }
  const [outer, inner] = equal
    ? smallerBlock(left, right) === left
      ? [right, left]
      : [left, right]
    : leftContains
      ? [left, right]
      : [right, left];
  if (
    inner.classification.contextRequired.length > 0 &&
    contains(outer.blockRange, inner.blockRange)
  ) {
    return { keep: outer, drop: inner, kind: "expand" };
  }
  if (
    inner.block.kind === "loop" &&
    !inner.assessment.behaviorChanged &&
    GROUP_ORDER[outer.classification.group] < GROUP_ORDER[inner.classification.group]
  ) {
    return { keep: outer, drop: inner, kind: "duplicate" };
  }
  const smaller = smallerBlock(inner, outer);
  return {
    keep: smaller,
    drop: smaller === inner ? outer : inner,
    kind: "duplicate",
  };
}

function order(candidates: readonly Candidate[]): RankedBlock[] {
  const sorted = [...candidates].sort((left, right) => {
    const group = GROUP_ORDER[left.classification.group] - GROUP_ORDER[right.classification.group];
    if (group !== 0) {
      return group;
    }
    if (left.classification.score !== right.classification.score) {
      return right.classification.score - left.classification.score;
    }
    if (left.block.path !== right.block.path) {
      return left.block.path < right.block.path ? -1 : 1;
    }
    if (left.range.startLine !== right.range.startLine) {
      return left.range.startLine - right.range.startLine;
    }
    return left.block.id < right.block.id ? -1 : left.block.id > right.block.id ? 1 : 0;
  });
  return sorted.map((candidate, index) => toRanked(candidate, index + 1));
}

function toRanked(candidate: Candidate, rank: number): RankedBlock {
  const group = candidate.classification.group;
  return {
    blockId: candidate.block.id,
    path: candidate.block.path,
    name: candidate.block.name,
    kind: candidate.block.kind,
    group,
    band: bandFor(group),
    rank,
    score: candidate.classification.score,
    side: candidate.side,
    range: candidate.range,
    blockRange: candidate.blockRange,
    reviewReason: candidate.assessment.reviewReason,
    evidence: candidate.evidence,
    reasons: candidate.classification.reasons,
    confidence: candidate.assessment.confidence,
    uncertaintyReasons: candidate.uncertaintyReasons,
    contextRequired: candidate.classification.contextRequired,
    behaviorChanged: candidate.assessment.behaviorChanged,
    businessImpact: candidate.assessment.businessImpact,
  };
}

function analysisStatus(
  blocks: readonly LogicalBlock[],
  assessments: readonly BlockAssessment[],
  selected: readonly RankedBlock[],
): FocusReport["analysisStatus"] {
  if (blocks.length === 0) {
    return "complete";
  }
  if (assessments.length === 0) {
    return "unavailable";
  }
  const assessed = new Set(assessments.map((assessment) => assessment.blockId));
  const missing = blocks.some((block) => block.changedLines.length > 0 && !assessed.has(block.id));
  if (missing || selected.some((item) => item.group === "needs_context")) {
    return "partial";
  }
  return "complete";
}

function passesMinBand(group: ReviewGroup, minBand: PriorityBand): boolean {
  if (group === "needs_context") {
    return true;
  }
  return BAND_RANK[bandFor(group)] >= BAND_RANK[minBand];
}

function bandFor(group: ReviewGroup): PriorityBand {
  if (group === "must_review") {
    return "high";
  }
  if (group === "low_priority") {
    return "low";
  }
  return "medium";
}

function overlaps(left: Candidate, right: Candidate): boolean {
  return (
    left.block.path === right.block.path &&
    left.side === right.side &&
    left.range.startLine <= right.range.endLine &&
    right.range.startLine <= left.range.endLine
  );
}

function contains(outer: LineRange, inner: LineRange): boolean {
  return (
    outer.startLine <= inner.startLine &&
    outer.endLine >= inner.endLine &&
    (outer.startLine < inner.startLine || outer.endLine > inner.endLine)
  );
}

function sameRange(left: LineRange, right: LineRange): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine;
}

function smallerBlock(left: Candidate, right: Candidate): Candidate {
  const size = rangeSize(left.blockRange) - rangeSize(right.blockRange);
  if (size !== 0) {
    return size < 0 ? left : right;
  }
  const specificity = SPECIFICITY.indexOf(left.block.kind) - SPECIFICITY.indexOf(right.block.kind);
  if (specificity !== 0) {
    return specificity < 0 ? left : right;
  }
  return left.block.id <= right.block.id ? left : right;
}

function prefer(left: Candidate, right: Candidate): Candidate {
  const group = GROUP_ORDER[left.classification.group] - GROUP_ORDER[right.classification.group];
  if (group !== 0) {
    return group < 0 ? left : right;
  }
  if (left.classification.score !== right.classification.score) {
    return left.classification.score > right.classification.score ? left : right;
  }
  return smallerBlock(left, right);
}

function combinedGroup(left: ReviewGroup, right: ReviewGroup): ReviewGroup {
  if (left === "needs_context" || right === "needs_context") {
    return "needs_context";
  }
  return GROUP_ORDER[left] <= GROUP_ORDER[right] ? left : right;
}

function span(ranges: readonly LineRange[]): LineRange | null {
  const first = ranges[0];
  if (first === undefined) {
    return null;
  }
  return {
    startLine: Math.min(...ranges.map((range) => range.startLine)),
    endLine: Math.max(...ranges.map((range) => range.endLine)),
  };
}

function intersection(changed: LineRange, blockRange: LineRange): LineRange | null {
  const startLine = Math.max(changed.startLine, blockRange.startLine);
  const endLine = Math.min(changed.endLine, blockRange.endLine);
  if (startLine > endLine) {
    return null;
  }
  return { startLine, endLine };
}

function union(left: LineRange, right: LineRange): LineRange {
  return {
    startLine: Math.min(left.startLine, right.startLine),
    endLine: Math.max(left.endLine, right.endLine),
  };
}

function rangeSize(range: LineRange): number {
  return range.endLine - range.startLine;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function relatedTestCount(
  tests: readonly { relatedBlockIds: readonly string[] }[],
  blockId: string,
): number {
  return tests.filter((test) => test.relatedBlockIds.includes(blockId)).length;
}

function unassessed(blockId: string): BlockAssessment {
  return {
    blockId,
    behaviorChanged: false,
    businessImpact: "unknown",
    reviewReason: "Behavior was not assessed.",
    evidence: [],
    contextRequired: ["No semantic assessment was supplied for this block."],
    confidence: "low",
    uncertaintyReasons: ["No semantic assessment was supplied for this block."],
    signals: [],
  };
}
