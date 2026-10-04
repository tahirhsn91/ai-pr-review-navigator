import type { PullRequestFile, PullRequestFileStatus, PullRequestRef } from "../github/types.js";
import type { LineRange } from "../shared/location.js";

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

export type PatchStatus = "parsed" | "missing" | "invalid" | "binary";

export interface FileDiff {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: PullRequestFileStatus;
  readonly hunks: readonly DiffHunk[];
  readonly addedRanges: readonly LineRange[];
  readonly removedRanges: readonly LineRange[];
  readonly patchStatus: PatchStatus;
  readonly lineMappingComplete: boolean;
}

export interface DiffParser {
  parse(files: readonly PullRequestFile[]): readonly FileDiff[];
}

export interface FileIndicators {
  readonly binary: boolean;
  readonly generated: boolean;
  readonly oversized: boolean;
  readonly unsupported: boolean;
}

export type FileSource =
  | { readonly status: "present"; readonly text: string; readonly byteLength: number }
  | { readonly status: "absent"; readonly reason: "not_in_base" | "not_in_head" | "not_found" }
  | { readonly status: "binary"; readonly byteLength: number }
  | { readonly status: "oversized"; readonly byteLength: number }
  | { readonly status: "unsupported"; readonly reason: string };

export interface ProcessedFileChange extends FileDiff {
  readonly baseSha: string;
  readonly headSha: string;
  readonly base: FileSource;
  readonly head: FileSource;
  readonly indicators: FileIndicators;
  readonly contentComplete: boolean;
  readonly rename?: { readonly from: string; readonly to: string };
  readonly deletion?: { readonly path: string };
}

export interface PullRequestDiff {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly ProcessedFileChange[];
  readonly complete: boolean;
}
