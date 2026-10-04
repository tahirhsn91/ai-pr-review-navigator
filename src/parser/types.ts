import type { FileDiff } from "../diff/types.js";
import type { LineRange } from "../shared/location.js";

export const LOGICAL_BLOCK_KINDS = [
  "function",
  "method",
  "class",
  "module",
  "type",
  "other",
] as const;

export type LogicalBlockKind = (typeof LOGICAL_BLOCK_KINDS)[number];

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface LogicalBlock {
  readonly id: string;
  readonly path: string;
  readonly kind: LogicalBlockKind;
  readonly name: string;
  readonly range: LineRange;
  readonly changedLines: LineRange;
}

export interface ChangedBlockRequest {
  readonly diffs: readonly FileDiff[];
  readonly sources: readonly SourceFile[];
}

export interface CodeParser {
  findChangedBlocks(input: ChangedBlockRequest): Promise<readonly LogicalBlock[]>;
}
