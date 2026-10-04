import type { FileDiff } from "../diff/types.js";
import type { LineRange } from "../shared/location.js";

export const LOGICAL_BLOCK_KINDS = [
  "function",
  "method",
  "class",
  "conditional",
  "loop",
  "calculation",
  "return",
  "database_call",
  "external_call",
  "validation",
  "authorization",
  "exception_handler",
  "event_publish",
  "transaction",
  "unknown",
] as const;

export type LogicalBlockKind = (typeof LOGICAL_BLOCK_KINDS)[number];

export type StructuralKind = Exclude<LogicalBlockKind, "unknown">;

export const BLOCK_CHANGES = ["new", "removed", "modified", "moved"] as const;

export type BlockChange = (typeof BLOCK_CHANGES)[number];

export const PARSE_STATUSES = ["parsed", "partial", "unsupported", "unmapped"] as const;

export type ParseStatus = (typeof PARSE_STATUSES)[number];

export const MAPPING_CONFIDENCE = ["high", "medium", "low"] as const;

export type MappingConfidence = (typeof MAPPING_CONFIDENCE)[number];

export interface SourceFile {
  readonly path: string;
  readonly baseText: string | null;
  readonly headText: string | null;
}

export interface EnclosingFrame {
  readonly kind: StructuralKind;
  readonly name: string;
  readonly range: LineRange;
}

export interface ChangedLineRange {
  readonly side: "base" | "head";
  readonly range: LineRange;
}

export interface LogicalBlock {
  readonly id: string;
  readonly path: string;
  readonly kind: LogicalBlockKind;
  readonly name: string;
  readonly enclosingSymbol: string | null;
  readonly context: readonly EnclosingFrame[];
  readonly baseRange: LineRange | null;
  readonly headRange: LineRange | null;
  readonly changedLines: readonly ChangedLineRange[];
  readonly change: BlockChange;
  readonly confidence: MappingConfidence;
  readonly parseStatus: ParseStatus;
}

export interface ChangedBlockRequest {
  readonly diffs: readonly FileDiff[];
  readonly sources: readonly SourceFile[];
  readonly languages?: readonly string[];
  readonly ignore?: readonly string[];
}

export interface CodeParser {
  findChangedBlocks(input: ChangedBlockRequest): Promise<readonly LogicalBlock[]>;
}

export interface SyntaxNode {
  readonly kind: StructuralKind;
  readonly name: string;
  readonly header: string;
  readonly body: string;
  readonly range: LineRange;
  readonly enclosingSymbol: string | null;
  readonly context: readonly EnclosingFrame[];
  readonly depth: number;
}

export interface SyntaxTree {
  readonly parseStatus: "parsed" | "partial";
  readonly nodes: readonly SyntaxNode[];
}

export interface LanguageSyntaxParser {
  readonly id: string;
  readonly extensions: Readonly<Record<string, string>>;
  parse(input: { readonly path: string; readonly text: string }): SyntaxTree;
}

export interface ParserRegistry {
  register(parser: LanguageSyntaxParser): void;
  resolve(
    path: string,
  ): { readonly parser: LanguageSyntaxParser; readonly language: string } | undefined;
}
