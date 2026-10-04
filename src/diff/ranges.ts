import type { LineRange } from "../shared/location.js";

export function coalesceLineNumbers(lines: readonly number[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last !== undefined && line === last.endLine + 1) {
      ranges[ranges.length - 1] = { startLine: last.startLine, endLine: line };
      continue;
    }
    ranges.push({ startLine: line, endLine: line });
  }
  return ranges;
}
