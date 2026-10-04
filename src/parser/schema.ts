import { z } from "zod";

import { ReviewNavigatorError } from "../shared/errors.js";
import { BLOCK_CHANGES, LOGICAL_BLOCK_KINDS, MAPPING_CONFIDENCE, PARSE_STATUSES } from "./types.js";
import type { LogicalBlock } from "./types.js";

const lineRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.endLine >= range.startLine, "Line range is reversed.");

const structuralKinds = LOGICAL_BLOCK_KINDS.filter((kind) => kind !== "unknown");

const frameSchema = z
  .object({
    kind: z.enum(structuralKinds as [string, ...string[]]),
    name: z.string().min(1),
    range: lineRangeSchema,
  })
  .strict();

export const logicalBlockSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(LOGICAL_BLOCK_KINDS),
    name: z.string().min(1),
    enclosingSymbol: z.string().min(1).nullable(),
    context: z.array(frameSchema),
    baseRange: lineRangeSchema.nullable(),
    headRange: lineRangeSchema.nullable(),
    changedLines: z.array(
      z
        .object({
          side: z.enum(["base", "head"]),
          range: lineRangeSchema,
        })
        .strict(),
    ),
    change: z.enum(BLOCK_CHANGES),
    confidence: z.enum(MAPPING_CONFIDENCE),
    parseStatus: z.enum(PARSE_STATUSES),
  })
  .strict()
  .superRefine((block, context) => {
    if (!rangesAgree(block)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logical block ranges do not match the recorded change.",
      });
    }
  });

export class ParserModelError extends ReviewNavigatorError {
  constructor() {
    super("parser_model_invalid", "Logical block model failed validation.");
  }
}

export function assertLogicalBlocks(blocks: readonly LogicalBlock[]): readonly LogicalBlock[] {
  const parsed = z.array(logicalBlockSchema).safeParse(blocks);
  if (!parsed.success) {
    throw new ParserModelError();
  }
  return blocks;
}

function rangesAgree(block: {
  readonly kind: string;
  readonly change: string;
  readonly parseStatus: string;
  readonly baseRange: { startLine: number; endLine: number } | null;
  readonly headRange: { startLine: number; endLine: number } | null;
  readonly changedLines: readonly {
    readonly side: string;
    readonly range: { startLine: number; endLine: number };
  }[];
}): boolean {
  const uncertain = block.parseStatus === "unmapped" || block.parseStatus === "unsupported";
  if (uncertain || block.kind === "unknown") {
    return block.baseRange === null && block.headRange === null;
  }
  if (block.change === "new" && block.baseRange !== null) {
    return false;
  }
  if (block.change === "removed" && block.headRange !== null) {
    return false;
  }
  if (
    (block.change === "modified" || block.change === "moved") &&
    (block.baseRange === null || block.headRange === null)
  ) {
    return false;
  }
  return block.changedLines.every((changed) => {
    const range = changed.side === "head" ? block.headRange : block.baseRange;
    return (
      range !== null &&
      changed.range.startLine >= range.startLine &&
      changed.range.endLine <= range.endLine
    );
  });
}
