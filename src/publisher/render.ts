import type { ReviewFocusItem, ReviewFocusReport } from "./types.js";

export const SUMMARY_MARKER = "<!-- review-navigator:summary -->";
export const INCOMPLETE_MARKER = "<!-- review-navigator:incomplete -->";
const INLINE_PREFIX = "<!-- review-navigator:inline ";

const GROUP_TITLE = {
  must_review: "MUST REVIEW",
  review_if_relevant: "REVIEW IF RELEVANT",
  low_priority: "LOW PRIORITY",
  needs_context: "NEEDS CONTEXT",
} as const;

export function inlineMarker(blockId: string): string {
  return `${INLINE_PREFIX}${encodeURIComponent(blockId)} -->`;
}

export function readInlineBlockId(body: string): string | undefined {
  const start = body.indexOf(INLINE_PREFIX);
  if (start < 0) {
    return undefined;
  }
  const valueStart = start + INLINE_PREFIX.length;
  const end = body.indexOf(" -->", valueStart);
  if (end < 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(body.slice(valueStart, end));
  } catch {
    return undefined;
  }
}

export function renderSummary(report: ReviewFocusReport): string {
  const mustReview = report.blocks.filter((block) => block.group === "must_review");
  const optional = report.blocks.filter((block) => block.group === "review_if_relevant");
  const lowPriority = report.blocks.filter((block) => block.group === "low_priority");
  const needsContext = report.blocks.filter((block) => block.group === "needs_context");
  const lines = [
    SUMMARY_MARKER,
    "## AI Review Focus",
    "",
    `Analyzed ${report.blocks.length} blocks. ${mustReview.length} must be reviewed, ${optional.length} are optional, ${lowPriority.length} are low priority, and ${needsContext.length} need context.`,
    "",
    `Base: \`${report.baseSha}\``,
    `Head: \`${report.headSha}\``,
    `Status: ${report.analysisStatus}`,
    ...statusNote(report.analysisStatus),
    "",
    "Priorities indicate review importance, not verified defects.",
    "",
    section("must_review", mustReview, report),
    section("review_if_relevant", optional, report),
    lowPrioritySection(lowPriority, report),
    section("needs_context", needsContext, report),
  ];
  if (report.overflowCount > 0) {
    lines.push(
      "",
      `${report.overflowCount} important blocks are past the short display budget and remain listed in this comment.`,
    );
  }
  return lines.join("\n");
}

export function renderInline(report: ReviewFocusReport, block: ReviewFocusItem): string {
  const changed = lineLink(report, block, block.range);
  const lines = [
    inlineMarker(block.blockId),
    `**${plain(block.name)}** — MUST REVIEW`,
    "",
    plain(block.reviewReason),
    "",
    `Changed lines ${formatRange(block.range)} in ${changed}.`,
  ];
  if (!sameRange(block.range, block.blockRange)) {
    lines.push(
      `The logical block continues at lines ${formatRange(block.blockRange)}: ${lineLink(report, block, block.blockRange)}.`,
    );
  }
  lines.push("", "This marks review importance, not a verified defect.");
  return lines.join("\n");
}

function statusNote(status: ReviewFocusReport["analysisStatus"]): string[] {
  if (status === "complete") {
    return [];
  }
  if (status === "unavailable") {
    return ["", "Analysis did not finish. Listed blocks are uncertain."];
  }
  return ["", "Analysis is incomplete."];
}

function section(
  group: ReviewFocusItem["group"],
  blocks: readonly ReviewFocusItem[],
  report: ReviewFocusReport,
): string {
  const items = blocks.map((block) => itemLine(report, block));
  return [`### ${GROUP_TITLE[group]}`, "", items.length > 0 ? items.join("\n") : "None."].join(
    "\n",
  );
}

function lowPrioritySection(blocks: readonly ReviewFocusItem[], report: ReviewFocusReport): string {
  const items = blocks.map((block) => itemLine(report, block));
  return [
    "<details>",
    `<summary>Low priority (${blocks.length})</summary>`,
    "",
    items.length > 0 ? items.join("\n") : "None.",
    "",
    "</details>",
  ].join("\n");
}

function itemLine(report: ReviewFocusReport, block: ReviewFocusItem): string {
  return `- **${plain(block.name)}** — ${lineLink(report, block, block.range)} lines ${formatRange(block.range)}. ${plain(block.reviewReason)}`;
}

function lineLink(
  report: ReviewFocusReport,
  block: ReviewFocusItem,
  range: ReviewFocusItem["range"],
): string {
  const sha = block.side === "head" ? report.headSha : report.baseSha;
  const file = block.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const anchor =
    range.startLine === range.endLine
      ? `#L${range.startLine}`
      : `#L${range.startLine}-L${range.endLine}`;
  const url = `https://github.com/${encodeURIComponent(report.pullRequest.owner)}/${encodeURIComponent(report.pullRequest.repo)}/blob/${sha}/${file}${anchor}`;
  return `[\`${plain(block.path)}\`](${url})`;
}

function formatRange(range: ReviewFocusItem["range"]): string {
  return range.startLine === range.endLine
    ? String(range.startLine)
    : `${range.startLine}–${range.endLine}`;
}

function sameRange(left: ReviewFocusItem["range"], right: ReviewFocusItem["range"]): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine;
}

function plain(value: string): string {
  return value
    .replaceAll("<!--", "")
    .replaceAll("-->", "")
    .replaceAll(/[\r\n]+/gu, " ")
    .trim();
}
