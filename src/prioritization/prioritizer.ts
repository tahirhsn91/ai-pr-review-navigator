import { unimplementedSync } from "../shared/unimplemented.js";
import { PrioritizationError } from "./errors.js";
import { parseFocusReport } from "./schema.js";
import { selectFocus } from "./select.js";
import type { FocusReport, Prioritizer, RankBlocksRequest } from "./types.js";

const SHA = /^[0-9a-f]{40}$/iu;

export function createUnimplementedPrioritizer(): Prioritizer {
  return {
    rank: unimplementedSync("Prioritizer.rank"),
  };
}

export function createPrioritizer(): Prioritizer {
  return {
    rank,
  };
}

function rank(input: RankBlocksRequest): FocusReport {
  assertSha("baseSha", input.baseSha);
  assertSha("headSha", input.headSha);
  assertUnique(
    input.blocks.map((block) => block.id),
    "Duplicate block id.",
  );
  assertUnique(
    input.assessments.map((assessment) => assessment.blockId),
    "Duplicate assessment for a block.",
  );
  return parseFocusReport({
    baseSha: input.baseSha.toLowerCase(),
    headSha: input.headSha.toLowerCase(),
    ...selectFocus(input),
  });
}

function assertSha(name: "baseSha" | "headSha", value: string): void {
  if (!SHA.test(value)) {
    throw new PrioritizationError(`${name} must be a 40-character Git SHA.`);
  }
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) {
    throw new PrioritizationError(message);
  }
}
