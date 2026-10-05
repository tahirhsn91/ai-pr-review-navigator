import type { LineRange } from "../shared/location.js";
import { unimplemented } from "../shared/unimplemented.js";
import { isIgnored } from "./ignore.js";
import { diffLineNumbers, lineNumbers, matchChangedBlocks } from "./match.js";
import { createParserRegistry } from "./registry.js";
import { assertLogicalBlocks } from "./schema.js";
import { createTypeScriptSyntaxParser } from "./tree.js";
import type {
  ChangedBlockRequest,
  ChangedLineRange,
  CodeParser,
  LogicalBlock,
  ParseStatus,
  ParserRegistry,
  SourceFile,
} from "./types.js";
import type { FileDiff } from "../diff/types.js";

export function createUnimplementedCodeParser(): CodeParser {
  return {
    findChangedBlocks: unimplemented("CodeParser.findChangedBlocks"),
  };
}

export function createCodeParser(
  registry: ParserRegistry = createDefaultParserRegistry(),
): CodeParser {
  return {
    findChangedBlocks(input) {
      return Promise.resolve(assertLogicalBlocks(findChangedBlocks(input, registry)));
    },
  };
}

export function createDefaultParserRegistry(): ParserRegistry {
  const registry = createParserRegistry();
  registry.register(createTypeScriptSyntaxParser());
  return registry;
}

function findChangedBlocks(input: ChangedBlockRequest, registry: ParserRegistry): LogicalBlock[] {
  const ignore = input.ignore ?? [];
  const blocks: LogicalBlock[] = [];
  for (const diff of input.diffs) {
    if (isIgnored(diff.path, ignore)) {
      continue;
    }
    if (diff.previousPath !== undefined && isIgnored(diff.previousPath, ignore)) {
      continue;
    }
    blocks.push(
      ...blocksForDiff(diff, sourceFor(input.sources, diff.path), input.languages, registry),
    );
  }
  return blocks;
}

function blocksForDiff(
  diff: FileDiff,
  source: SourceFile | undefined,
  languages: readonly string[] | undefined,
  registry: ParserRegistry,
): readonly LogicalBlock[] {
  const lineRanges = diffLineNumbers(diff);
  const hasRanges = lineRanges.base.length > 0 || lineRanges.head.length > 0;
  const baseLines = lineNumbers(lineRanges.base, source?.baseText ?? null);
  const headLines = lineNumbers(lineRanges.head, source?.headText ?? null);
  if (baseLines.length === 0 && headLines.length === 0) {
    if (hasRanges || diff.patchStatus !== "parsed" || !diff.lineMappingComplete) {
      return [uncertain(diff, diff.patchStatus === "binary" ? "unsupported" : "unmapped", source)];
    }
    return [];
  }

  const resolved = registry.resolve(diff.path);
  if (
    diff.patchStatus === "binary" ||
    resolved === undefined ||
    (languages !== undefined && !languages.includes(resolved.language))
  ) {
    return matchChangedBlocks({
      path: diff.path,
      status: diff.status,
      baseNodes: [],
      headNodes: [],
      baseLines,
      headLines,
      parseStatus: "unsupported",
    });
  }

  const baseTree =
    source?.baseText === null || source?.baseText === undefined
      ? { parseStatus: "parsed" as const, nodes: [] }
      : resolved.parser.parse({ path: diff.previousPath ?? diff.path, text: source.baseText });
  const headTree =
    source?.headText === null || source?.headText === undefined
      ? { parseStatus: "parsed" as const, nodes: [] }
      : resolved.parser.parse({ path: diff.path, text: source.headText });
  const parseStatus: ParseStatus =
    baseTree.parseStatus === "partial" || headTree.parseStatus === "partial" ? "partial" : "parsed";
  return matchChangedBlocks({
    path: diff.path,
    status: diff.status,
    baseNodes: baseTree.nodes,
    headNodes: headTree.nodes,
    baseLines,
    headLines,
    parseStatus,
  });
}

function uncertain(
  diff: FileDiff,
  parseStatus: "unmapped" | "unsupported",
  source: SourceFile | undefined,
): LogicalBlock {
  return {
    id: `${diff.path}#${parseStatus}`,
    path: diff.path,
    kind: "unknown",
    name: diff.path,
    enclosingSymbol: null,
    context: [],
    baseRange: null,
    headRange: null,
    changedLines: unmappedLines(diff, source),
    change: diff.status === "added" ? "new" : diff.status === "removed" ? "removed" : "modified",
    confidence: "low",
    parseStatus,
  };
}

function unmappedLines(
  diff: FileDiff,
  source: SourceFile | undefined,
): readonly ChangedLineRange[] {
  const head = textSpan(source?.headText ?? null);
  const base = textSpan(source?.baseText ?? null);
  if (diff.status === "removed") {
    return base === null ? [] : [{ side: "base", range: base }];
  }
  if (head !== null) {
    return [{ side: "head", range: head }];
  }
  return base === null ? [] : [{ side: "base", range: base }];
}

function textSpan(text: string | null): LineRange | null {
  if (text === null || text.length === 0) {
    return null;
  }
  return { startLine: 1, endLine: text.split("\n").length };
}

function sourceFor(sources: readonly SourceFile[], path: string): SourceFile | undefined {
  return sources.find((source) => source.path === path);
}
