import { coalesceLineNumbers } from "../diff/ranges.js";
import type { FileDiff } from "../diff/types.js";
import type { LineRange } from "../shared/location.js";
import type {
  BlockChange,
  ChangedLineRange,
  LogicalBlock,
  MappingConfidence,
  ParseStatus,
  StructuralKind,
  SyntaxNode,
} from "./types.js";

const HEURISTIC_KINDS = new Set<StructuralKind>([
  "calculation",
  "database_call",
  "external_call",
  "validation",
  "authorization",
  "event_publish",
  "transaction",
]);

const KIND_RANK: Record<StructuralKind, number> = {
  authorization: 0,
  validation: 1,
  transaction: 2,
  database_call: 3,
  external_call: 4,
  event_publish: 5,
  exception_handler: 6,
  calculation: 7,
  return: 8,
  conditional: 9,
  loop: 10,
  method: 11,
  function: 12,
  class: 13,
};

interface NodePair {
  readonly base: SyntaxNode | null;
  readonly head: SyntaxNode | null;
  readonly pairedBy: "key" | "body";
  readonly idKey: string;
}

export function matchChangedBlocks(input: {
  readonly path: string;
  readonly status: FileDiff["status"];
  readonly baseNodes: readonly SyntaxNode[];
  readonly headNodes: readonly SyntaxNode[];
  readonly baseLines: readonly number[];
  readonly headLines: readonly number[];
  readonly parseStatus: ParseStatus;
}): LogicalBlock[] {
  const pairs = pairNodes(input.baseNodes, input.headNodes);
  const baseLines = linesByNode(input.baseNodes, input.baseLines);
  const headLines = linesByNode(input.headNodes, input.headLines);
  const blocks: LogicalBlock[] = [];
  const seen = new Map<string, number>();

  for (const pair of pairs) {
    const removed = pair.base === null ? [] : (baseLines.owned.get(pair.base) ?? []);
    const added = pair.head === null ? [] : (headLines.owned.get(pair.head) ?? []);
    const change = classify(pair, removed.length > 0 || added.length > 0);
    if (change === undefined) {
      continue;
    }
    const node = pair.head ?? pair.base;
    if (node === null) {
      continue;
    }
    blocks.push(
      blockFromPair(input.path, pair, node, change, removed, added, input.parseStatus, seen),
    );
  }

  blocks.push(
    ...unknownBlocks(
      input.path,
      input.status,
      baseLines.unmapped,
      headLines.unmapped,
      input.parseStatus === "unsupported" ? "unsupported" : "unmapped",
      seen,
    ),
  );
  return blocks.sort(compareBlocks);
}

function pairNodes(baseNodes: readonly SyntaxNode[], headNodes: readonly SyntaxNode[]): NodePair[] {
  const baseKeyed = keyed(baseNodes);
  const headKeyed = keyed(headNodes);
  const headByKey = new Map(headKeyed.map((item) => [item.key, item]));
  const consumedBase = new Set<SyntaxNode>();
  const consumedHead = new Set<SyntaxNode>();
  const pairs: NodePair[] = [];

  for (const item of baseKeyed) {
    const head = headByKey.get(item.key);
    if (head === undefined) {
      continue;
    }
    consumedBase.add(item.node);
    consumedHead.add(head.node);
    pairs.push({ base: item.node, head: head.node, pairedBy: "key", idKey: head.key });
  }

  const unmatchedBase = baseKeyed
    .filter((item) => !consumedBase.has(item.node))
    .map((item) => item.node);
  const unmatchedHead = headKeyed
    .filter((item) => !consumedHead.has(item.node))
    .map((item) => item.node);
  const bodyPairs = pairByBody(
    unmatchedBase.filter((node) => node.kind === "function" || node.kind === "method"),
    unmatchedHead.filter((node) => node.kind === "function" || node.kind === "method"),
  );
  const bodyBase = new Set(bodyPairs.map((pair) => pair.base));
  const bodyHead = new Set(bodyPairs.map((pair) => pair.head));
  for (const pair of bodyPairs) {
    const headKey = headKeyed.find((item) => item.node === pair.head)?.key ?? stemOf(pair.head);
    pairs.push({ base: pair.base, head: pair.head, pairedBy: "body", idKey: headKey });
  }
  for (const item of baseKeyed) {
    if (!consumedBase.has(item.node) && !bodyBase.has(item.node)) {
      pairs.push({ base: item.node, head: null, pairedBy: "key", idKey: item.key });
    }
  }
  for (const item of headKeyed) {
    if (!consumedHead.has(item.node) && !bodyHead.has(item.node)) {
      pairs.push({ base: null, head: item.node, pairedBy: "key", idKey: item.key });
    }
  }
  return pairs;
}

function keyed(
  nodes: readonly SyntaxNode[],
): { readonly node: SyntaxNode; readonly key: string }[] {
  const counts = new Map<string, number>();
  return nodes.map((node) => {
    const stem = stemOf(node);
    const seen = counts.get(stem) ?? 0;
    counts.set(stem, seen + 1);
    return { node, key: `${stem}#${seen}` };
  });
}

function stemOf(node: SyntaxNode): string {
  return [node.kind, node.enclosingSymbol ?? "", slotOf(node)].join("|");
}

function slotOf(node: SyntaxNode): string {
  if (node.kind === "function" || node.kind === "method" || node.kind === "class") {
    return fingerprint(node.name);
  }
  if (
    node.kind === "database_call" ||
    node.kind === "external_call" ||
    node.kind === "event_publish" ||
    node.kind === "validation" ||
    node.kind === "authorization" ||
    node.kind === "transaction"
  ) {
    return fingerprint(node.name);
  }
  return node.kind;
}

function pairByBody(
  baseNodes: readonly SyntaxNode[],
  headNodes: readonly SyntaxNode[],
): { readonly base: SyntaxNode; readonly head: SyntaxNode }[] {
  const groups = new Map<string, { base: SyntaxNode[]; head: SyntaxNode[] }>();
  for (const node of baseNodes) {
    const group = groups.get(bodyKey(node)) ?? { base: [], head: [] };
    group.base.push(node);
    groups.set(bodyKey(node), group);
  }
  for (const node of headNodes) {
    const key = bodyKey(node);
    const group = groups.get(key) ?? { base: [], head: [] };
    group.head.push(node);
    groups.set(key, group);
  }
  const pairs: { base: SyntaxNode; head: SyntaxNode }[] = [];
  for (const group of groups.values()) {
    const base = group.base.length === 1 ? group.base[0] : undefined;
    const head = group.head.length === 1 ? group.head[0] : undefined;
    if (base !== undefined && head !== undefined) {
      pairs.push({ base, head });
    }
  }
  return pairs;
}

function bodyKey(node: SyntaxNode): string {
  return [node.kind, node.enclosingSymbol ?? "", fingerprint(node.body)].join("|");
}

function classify(pair: NodePair, hasChanges: boolean): BlockChange | undefined {
  if (!hasChanges) {
    return undefined;
  }
  if (pair.base === null) {
    return "new";
  }
  if (pair.head === null) {
    return "removed";
  }
  const sameBody = fingerprint(pair.base.body) === fingerprint(pair.head.body);
  const moved = pair.pairedBy === "body" || pair.base.range.startLine !== pair.head.range.startLine;
  if (sameBody && moved) {
    return "moved";
  }
  return "modified";
}

function linesByNode(
  nodes: readonly SyntaxNode[],
  lines: readonly number[],
): { readonly owned: Map<SyntaxNode, number[]>; readonly unmapped: number[] } {
  const owned = new Map<SyntaxNode, number[]>();
  const unmapped: number[] = [];
  for (const line of lines) {
    const node = smallestNode(nodes, line);
    if (node === undefined) {
      unmapped.push(line);
      continue;
    }
    const current = owned.get(node) ?? [];
    current.push(line);
    owned.set(node, current);
  }
  return { owned, unmapped };
}

function smallestNode(nodes: readonly SyntaxNode[], line: number): SyntaxNode | undefined {
  let best: SyntaxNode | undefined;
  for (const node of nodes) {
    if (line < node.range.startLine || line > node.range.endLine) {
      continue;
    }
    if (best === undefined || prefers(node, best)) {
      best = node;
    }
  }
  return best;
}

function prefers(candidate: SyntaxNode, current: SyntaxNode): boolean {
  const candidateSpan = candidate.range.endLine - candidate.range.startLine;
  const currentSpan = current.range.endLine - current.range.startLine;
  if (candidateSpan !== currentSpan) {
    return candidateSpan < currentSpan;
  }
  const candidateRank = KIND_RANK[candidate.kind];
  const currentRank = KIND_RANK[current.kind];
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank;
  }
  return candidate.depth > current.depth;
}

function blockFromPair(
  path: string,
  pair: NodePair,
  node: SyntaxNode,
  change: BlockChange,
  removed: readonly number[],
  added: readonly number[],
  parseStatus: ParseStatus,
  seen: Map<string, number>,
): LogicalBlock {
  const status = parseStatus === "unsupported" ? "partial" : parseStatus;
  return {
    id: uniqueId(seen, `${path}#${pair.idKey}`),
    path,
    kind: node.kind,
    name: node.name,
    enclosingSymbol: node.enclosingSymbol,
    context: node.context,
    baseRange: pair.base === null ? null : pair.base.range,
    headRange: pair.head === null ? null : pair.head.range,
    changedLines: changedRanges(removed, added),
    change,
    confidence: confidenceFor(node.kind, pair.pairedBy, status),
    parseStatus: status === "unmapped" ? "parsed" : status,
  };
}

function unknownBlocks(
  path: string,
  status: FileDiff["status"],
  baseLines: readonly number[],
  headLines: readonly number[],
  parseStatus: "unsupported" | "unmapped",
  seen: Map<string, number>,
): LogicalBlock[] {
  if (baseLines.length === 0 && headLines.length === 0) {
    return [];
  }
  const removed = coalesceLineNumbers([...baseLines]);
  const added = coalesceLineNumbers([...headLines]);
  return [
    {
      id: uniqueId(seen, `${path}#unknown`),
      path,
      kind: "unknown",
      name: path,
      enclosingSymbol: null,
      context: [],
      baseRange: null,
      headRange: null,
      changedLines: [
        ...removed.map((range) => ({ side: "base" as const, range })),
        ...added.map((range) => ({ side: "head" as const, range })),
      ],
      change: fileChange(status, baseLines.length > 0, headLines.length > 0),
      confidence: "low",
      parseStatus,
    },
  ];
}

export function fileChange(
  status: FileDiff["status"],
  hasBase: boolean,
  hasHead: boolean,
): BlockChange {
  if (!hasBase && hasHead) {
    return "new";
  }
  if (hasBase && !hasHead) {
    return "removed";
  }
  if (status === "renamed") {
    return "moved";
  }
  if (status === "added") {
    return "new";
  }
  if (status === "removed") {
    return "removed";
  }
  return "modified";
}

function changedRanges(removed: readonly number[], added: readonly number[]): ChangedLineRange[] {
  return [
    ...coalesceLineNumbers([...removed]).map((range) => ({ side: "base" as const, range })),
    ...coalesceLineNumbers([...added]).map((range) => ({ side: "head" as const, range })),
  ];
}

function confidenceFor(
  kind: StructuralKind,
  pairedBy: "key" | "body",
  parseStatus: ParseStatus,
): MappingConfidence {
  if (parseStatus === "partial" || pairedBy === "body" || HEURISTIC_KINDS.has(kind)) {
    return "medium";
  }
  return "high";
}

function compareBlocks(left: LogicalBlock, right: LogicalBlock): number {
  const start = blockStart(left) - blockStart(right);
  if (start !== 0) {
    return start;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function blockStart(block: LogicalBlock): number {
  return (
    block.headRange?.startLine ??
    block.baseRange?.startLine ??
    block.changedLines[0]?.range.startLine ??
    0
  );
}

function uniqueId(seen: Map<string, number>, base: string): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}#${count}`;
}

function fingerprint(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 160 ? normalized.slice(0, 160) : normalized;
}

export function lineNumbers(ranges: readonly LineRange[], text: string | null): number[] {
  if (text === null) {
    return [];
  }
  const count = text.length === 0 ? 0 : text.split("\n").length;
  const lines: number[] = [];
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      if (line >= 1 && line <= count) {
        lines.push(line);
      }
    }
  }
  return lines;
}

export function diffLineNumbers(diff: FileDiff): { base: LineRange[]; head: LineRange[] } {
  const base: number[] = [];
  const head: number[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "delete" && line.oldLineNumber !== undefined) {
        base.push(line.oldLineNumber);
      }
      if (line.type === "add" && line.newLineNumber !== undefined) {
        head.push(line.newLineNumber);
      }
    }
  }
  if (base.length > 0 || head.length > 0) {
    return { base: coalesceLineNumbers(base), head: coalesceLineNumbers(head) };
  }
  return { base: [...diff.removedRanges], head: [...diff.addedRanges] };
}
