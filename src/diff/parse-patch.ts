import type { LineRange } from "../shared/location.js";
import type { DiffHunk, DiffLine } from "./types.js";
import { coalesceLineNumbers } from "./ranges.js";
import { isBinaryPatch } from "./indicators.js";

export interface ParsedPatch {
  readonly hunks: readonly DiffHunk[];
  readonly addedRanges: readonly LineRange[];
  readonly removedRanges: readonly LineRange[];
  readonly addedCount: number;
  readonly removedCount: number;
}

export type UnifiedDiffParse =
  | ({ readonly patchStatus: "parsed" } & ParsedPatch)
  | { readonly patchStatus: "binary" }
  | { readonly patchStatus: "invalid" };

interface HunkHeader {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export function parseUnifiedDiff(patch: string): UnifiedDiffParse {
  if (isBinaryPatch(patch)) {
    return { patchStatus: "binary" };
  }
  const lines = splitPatchLines(patch);
  if (lines.length === 0) {
    return { patchStatus: "invalid" };
  }

  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current === undefined) {
      return { patchStatus: "invalid" };
    }
    const header = parseHunkHeader(current);
    if (header === undefined) {
      return { patchStatus: "invalid" };
    }
    index += 1;
    const parsed = consumeHunk(lines, index, header);
    if (parsed === undefined) {
      return { patchStatus: "invalid" };
    }
    hunks.push(parsed.hunk);
    index = parsed.index;
  }

  const addedLines: number[] = [];
  const removedLines: number[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add" && line.newLineNumber !== undefined) {
        addedLines.push(line.newLineNumber);
      }
      if (line.type === "delete" && line.oldLineNumber !== undefined) {
        removedLines.push(line.oldLineNumber);
      }
    }
  }

  return {
    patchStatus: "parsed",
    hunks,
    addedRanges: coalesceLineNumbers(addedLines),
    removedRanges: coalesceLineNumbers(removedLines),
    addedCount: addedLines.length,
    removedCount: removedLines.length,
  };
}

function splitPatchLines(patch: string): string[] {
  const lines = patch.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function parseHunkHeader(line: string): HunkHeader | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (match === null) {
    return undefined;
  }
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  if (
    !Number.isInteger(oldStart) ||
    !Number.isInteger(newStart) ||
    !Number.isInteger(oldLines) ||
    !Number.isInteger(newLines)
  ) {
    return undefined;
  }
  return { oldStart, oldLines, newStart, newLines };
}

function consumeHunk(
  lines: readonly string[],
  startIndex: number,
  header: HunkHeader,
): { readonly hunk: DiffHunk; readonly index: number } | undefined {
  const hunkLines: DiffLine[] = [];
  let index = startIndex;
  let oldLine = header.oldStart;
  let newLine = header.newStart;
  let oldSeen = 0;
  let newSeen = 0;

  while (oldSeen < header.oldLines || newSeen < header.newLines) {
    const line = lines[index];
    if (line === undefined || line.startsWith("@@")) {
      return undefined;
    }
    index += 1;
    if (line.startsWith("\\")) {
      if (line !== "\\ No newline at end of file") {
        return undefined;
      }
      continue;
    }
    const parsed = parseDiffLine(line, oldLine, newLine);
    if (parsed === undefined) {
      return undefined;
    }
    hunkLines.push(parsed.line);
    oldLine = parsed.oldLine;
    newLine = parsed.newLine;
    oldSeen += parsed.oldDelta;
    newSeen += parsed.newDelta;
  }

  while (lines[index]?.startsWith("\\")) {
    if (lines[index] !== "\\ No newline at end of file") {
      return undefined;
    }
    index += 1;
  }

  if (oldSeen !== header.oldLines || newSeen !== header.newLines) {
    return undefined;
  }

  return {
    index,
    hunk: {
      oldStart: header.oldStart,
      oldLines: header.oldLines,
      newStart: header.newStart,
      newLines: header.newLines,
      lines: hunkLines,
    },
  };
}

function parseDiffLine(
  line: string,
  oldLine: number,
  newLine: number,
):
  | {
      readonly line: DiffLine;
      readonly oldLine: number;
      readonly newLine: number;
      readonly oldDelta: number;
      readonly newDelta: number;
    }
  | undefined {
  const prefix = line[0];
  const text = line.slice(1);
  if (prefix === "+") {
    return {
      line: { type: "add", text, newLineNumber: newLine },
      oldLine,
      newLine: newLine + 1,
      oldDelta: 0,
      newDelta: 1,
    };
  }
  if (prefix === "-") {
    return {
      line: { type: "delete", text, oldLineNumber: oldLine },
      oldLine: oldLine + 1,
      newLine,
      oldDelta: 1,
      newDelta: 0,
    };
  }
  if (prefix === " ") {
    return {
      line: { type: "context", text, oldLineNumber: oldLine, newLineNumber: newLine },
      oldLine: oldLine + 1,
      newLine: newLine + 1,
      oldDelta: 1,
      newDelta: 1,
    };
  }
  return undefined;
}
