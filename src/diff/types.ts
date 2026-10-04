import type { PullRequestFile, PullRequestFileStatus } from "../github/types.js";

export interface DiffLine {
  readonly type: "context" | "add" | "delete";
  readonly text: string;
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: PullRequestFileStatus;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffParser {
  parse(files: readonly PullRequestFile[]): readonly FileDiff[];
}
