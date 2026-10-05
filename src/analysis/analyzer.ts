import { unimplemented } from "../shared/unimplemented.js";
import { LlmUnavailableError, AnalysisError } from "./errors.js";
import { guardAssessment, unassessedBlock } from "./guard.js";
import { buildAnalysisPrompt } from "./prompt.js";
import { assertGuardedAssessment, parseSemanticAssessment } from "./schema.js";
import type {
  AssessBlocksRequest,
  BlockAssessment,
  ReviewFocusAnalyzer,
  SemanticModel,
} from "./types.js";
import type { LogicalBlock, SourceFile } from "../parser/types.js";

const MAX_OUTPUT_TOKENS = 600;
const RESPONSE_CHARS = 20_000;

export function createUnimplementedAnalyzer(): ReviewFocusAnalyzer {
  return {
    assess: unimplemented("ReviewFocusAnalyzer.assess"),
  };
}

export function createSemanticAnalyzer(): ReviewFocusAnalyzer {
  return {
    assess(input) {
      return assessBlocks(input);
    },
  };
}

async function assessBlocks(input: AssessBlocksRequest): Promise<readonly BlockAssessment[]> {
  const provider = input.provider;
  if (provider === undefined) {
    throw new LlmUnavailableError();
  }
  const assessments: BlockAssessment[] = [];
  for (const block of input.blocks) {
    assessments.push(await assessBlock(block, input, provider));
  }
  return assessments;
}

async function assessBlock(
  block: LogicalBlock,
  input: AssessBlocksRequest,
  provider: SemanticModel,
): Promise<BlockAssessment> {
  const prompt = buildAnalysisPrompt({
    block,
    source: sourceFor(input.sources ?? [], block.path),
    callers: input.callers ?? [],
    callees: input.callees ?? [],
    tests: input.tests ?? [],
    businessCriticality: input.businessCriticality ?? [],
  });
  if (!prompt.baseAvailable && !prompt.headAvailable) {
    return unassessedBlock(block, "Base and head source for this block were not available.");
  }
  const completion = await provider.complete({
    system: prompt.system,
    user: prompt.user,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (completion.text.length > RESPONSE_CHARS) {
    throw new AnalysisError("Model response was too large to validate.");
  }
  const parsed = parseSemanticAssessment(readModelJson(completion.text));
  if (parsed.blockId !== block.id) {
    throw new AnalysisError("Model response referenced a different block.");
  }
  const guarded = guardAssessment(parsed, block, prompt, input.enabledReasons);
  assertGuardedAssessment({
    blockId: guarded.blockId,
    behaviorChanged: guarded.behaviorChanged,
    businessImpact: guarded.businessImpact,
    reviewReason: guarded.reviewReason,
    evidence: [...guarded.evidence],
    contextRequired: [...guarded.contextRequired],
    confidence: guarded.confidence,
    uncertaintyReasons: [...guarded.uncertaintyReasons],
  });
  return guarded;
}

function readModelJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AnalysisError("Model response was not JSON.");
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new AnalysisError("Model response was not JSON.");
  }
}

function sourceFor(sources: readonly SourceFile[], path: string): SourceFile | undefined {
  return sources.find((source) => source.path === path);
}
