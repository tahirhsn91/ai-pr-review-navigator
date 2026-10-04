import { describe, expect, it } from "vitest";

import { createCodeParser, createParserRegistry } from "../src/parser/index.js";
import type { ChangedBlockRequest, LogicalBlock, SourceFile } from "../src/parser/types.js";
import type { FileDiff } from "../src/diff/types.js";
import type { LineRange } from "../src/shared/location.js";

const parser = createCodeParser();

function lineOf(text: string, needle: string): number {
  const index = text.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) {
    throw new Error(`missing ${needle}`);
  }
  return index + 1;
}

function changed(
  path: string,
  baseText: string | null,
  headText: string | null,
  removed: readonly LineRange[],
  added: readonly LineRange[],
  extras: Partial<FileDiff> = {},
): ChangedBlockRequest {
  const diff: FileDiff = {
    path,
    status: "modified",
    hunks: [],
    addedRanges: added,
    removedRanges: removed,
    patchStatus: "parsed",
    lineMappingComplete: true,
    ...extras,
  };
  const source: SourceFile = { path, baseText, headText };
  return { diffs: [diff], sources: [source] };
}

function line(text: string, needle: string): LineRange {
  const startLine = lineOf(text, needle);
  return { startLine, endLine: startLine };
}

function assertTraceable(
  blocks: readonly LogicalBlock[],
  base: string | null,
  head: string | null,
): void {
  const baseCount = base === null || base.length === 0 ? 0 : base.split("\n").length;
  const headCount = head === null || head.length === 0 ? 0 : head.split("\n").length;
  for (const block of blocks) {
    if (block.baseRange !== null) {
      expect(block.baseRange.startLine).toBeGreaterThan(0);
      expect(block.baseRange.endLine).toBeLessThanOrEqual(baseCount);
    }
    if (block.headRange !== null) {
      expect(block.headRange.startLine).toBeGreaterThan(0);
      expect(block.headRange.endLine).toBeLessThanOrEqual(headCount);
    }
    for (const changedLine of block.changedLines) {
      const limit = changedLine.side === "base" ? baseCount : headCount;
      expect(changedLine.range.startLine).toBeGreaterThan(0);
      expect(changedLine.range.endLine).toBeLessThanOrEqual(limit);
    }
    if (block.baseRange !== null) {
      for (const frame of block.context) {
        expect(frame.range.endLine).toBeLessThanOrEqual(baseCount);
      }
    }
  }
}

describe("logical blocks", () => {
  it("maps a nested loop change to the inner loop and leaves the outer loop unselected", async () => {
    const base = [
      "function collect(rows: string[][]) {",
      "  for (const row of rows) {",
      "    for (const value of row) {",
      "      seen = true;",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const head = base.replace("seen = true;", "seen = false;");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/collect.ts",
        base,
        head,
        [line(base, "seen = true")],
        [line(head, "seen = false")],
      ),
    );
    assertTraceable(blocks, base, head);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "loop",
      enclosingSymbol: "collect",
      change: "modified",
      parseStatus: "parsed",
      confidence: "high",
    });
    expect(blocks[0]?.name).toContain("for (const value of row)");
    expect(blocks[0]?.context.some((frame) => frame.name.includes("for (const row of rows)"))).toBe(
      true,
    );
    expect(blocks.some((block) => block.name.includes("for (const row of rows)"))).toBe(false);
  });

  it("maps a nested condition to the inner branch", async () => {
    const base = [
      "function gate(flag: boolean, other: boolean) {",
      "  if (flag) {",
      "    if (other) {",
      "      ready = true;",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const head = base.replace("ready = true;", "ready = false;");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/gate.ts",
        base,
        head,
        [line(base, "ready = true")],
        [line(head, "ready = false")],
      ),
    );
    assertTraceable(blocks, base, head);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "conditional",
      enclosingSymbol: "gate",
      change: "modified",
    });
    expect(blocks[0]?.name).toContain("other");
    expect(
      blocks[0]?.context.some(
        (frame) => frame.kind === "conditional" && frame.name.includes("flag"),
      ),
    ).toBe(true);
  });

  it("keeps a multiline calculation together", async () => {
    const base = [
      "function price(input: number) {",
      "  const total =",
      "    input *",
      "    2;",
      "  return total;",
      "}",
      "",
    ].join("\n");
    const head = base.replace("    2;", "    3;");
    const blocks = await parser.findChangedBlocks(
      changed("src/price.ts", base, head, [line(base, "2;")], [line(head, "3;")]),
    );
    assertTraceable(blocks, base, head);
    const calculation = blocks.find((block) => block.kind === "calculation");
    expect(calculation?.enclosingSymbol).toBe("price");
    expect(calculation?.headRange?.endLine).toBeGreaterThan(calculation?.headRange?.startLine ?? 0);
    expect(calculation?.headRange?.startLine).toBeLessThanOrEqual(lineOf(head, "input *"));
    expect(calculation?.headRange?.endLine).toBeGreaterThanOrEqual(lineOf(head, "3;"));
    expect(blocks.some((block) => block.kind === "function" && block.name === "price")).toBe(false);
  });

  it("selects an added function and ignores the unchanged neighbor", async () => {
    const base = ["export function keep() {", "  return 1;", "}", ""].join("\n");
    const head = [
      "export function keep() {",
      "  return 1;",
      "}",
      "",
      "export function added(value: number) {",
      "  return value + 1;",
      "}",
      "",
    ].join("\n");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/added.ts",
        base,
        head,
        [],
        [{ startLine: lineOf(head, "function added"), endLine: lineOf(head, "return value + 1") }],
      ),
    );
    assertTraceable(blocks, base, head);
    expect(
      blocks.find((block) => block.kind === "function" && block.name === "added"),
    ).toMatchObject({
      change: "new",
      baseRange: null,
      enclosingSymbol: null,
    });
    expect(blocks.some((block) => block.name === "keep")).toBe(false);
  });

  it("records a deleted function without a head range", async () => {
    const base = [
      "export function keep() {",
      "  return 1;",
      "}",
      "",
      "export function removed() {",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const head = ["export function keep() {", "  return 1;", "}", ""].join("\n");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/removed.ts",
        base,
        head,
        [{ startLine: lineOf(base, "function removed"), endLine: lineOf(base, "return 0") }],
        [],
      ),
    );
    assertTraceable(blocks, base, head);
    expect(
      blocks.find((block) => block.kind === "function" && block.name === "removed"),
    ).toMatchObject({
      change: "removed",
      headRange: null,
    });
    expect(blocks.some((block) => block.name === "keep")).toBe(false);
  });

  it("treats a function rename with the same body as a move", async () => {
    const base = ["function oldName(value: number) {", "  return value;", "}", ""].join("\n");
    const head = ["function newName(value: number) {", "  return value;", "}", ""].join("\n");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/rename.ts",
        base,
        head,
        [line(base, "function oldName")],
        [line(head, "function newName")],
      ),
    );
    assertTraceable(blocks, base, head);
    const functions = blocks.filter((block) => block.kind === "function");
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatchObject({
      name: "newName",
      change: "moved",
      confidence: "medium",
      baseRange: { startLine: 1, endLine: 3 },
      headRange: { startLine: 1, endLine: 3 },
    });
  });

  it("keeps a mapped block when the file has a syntax error", async () => {
    const base = [
      "function valid(value: number) {",
      "  return value;",
      "}",
      "",
      "const broken = {",
    ].join("\n");
    const head = base.replace("return value;", "return value + 1;");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/broken.ts",
        base,
        head,
        [line(base, "return value;")],
        [line(head, "return value + 1;")],
      ),
    );
    assertTraceable(blocks, base, head);
    expect(
      blocks.some((block) => block.enclosingSymbol === "valid" && block.parseStatus === "partial"),
    ).toBe(true);
    expect(blocks.every((block) => block.confidence !== "high")).toBe(true);
    expect(
      blocks.every(
        (block) => block.headRange === null || block.headRange.endLine <= head.split("\n").length,
      ),
    ).toBe(true);
  });

  it("maps one hunk that touches two functions onto both blocks", async () => {
    const base = [
      "function left() {",
      "  return 1;",
      "}",
      "",
      "function right() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    const head = base.replace("return 1;", "return 3;").replace("return 2;", "return 4;");
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/span.ts",
        base,
        head,
        [line(base, "return 1;"), line(base, "return 2;")],
        [line(head, "return 3;"), line(head, "return 4;")],
      ),
    );
    assertTraceable(blocks, base, head);
    expect(blocks.map((block) => block.enclosingSymbol).sort()).toEqual(["left", "right"]);
    expect(blocks.every((block) => block.kind === "return" || block.kind === "calculation")).toBe(
      true,
    );
  });

  it("does not select an unchanged loop just because it is present", async () => {
    const base = [
      "function run(flag: boolean) {",
      "  for (const item of items) {",
      "    ready = true;",
      "  }",
      "  if (flag) {",
      "    return 1;",
      "  }",
      "}",
      "",
    ].join("\n");
    const head = base.replace("return 1;", "return 2;");
    const blocks = await parser.findChangedBlocks(
      changed("src/run.ts", base, head, [line(base, "return 1;")], [line(head, "return 2;")]),
    );
    assertTraceable(blocks, base, head);
    expect(blocks.some((block) => block.kind === "loop")).toBe(false);
    expect(blocks.some((block) => block.kind === "return" && block.enclosingSymbol === "run")).toBe(
      true,
    );
  });

  it("labels syntactic call and condition shapes without selecting an untouched loop", async () => {
    const base = [
      "async function save(db: Db, user: User, events: Events) {",
      "  for (const item of items) {",
      "    ready = true;",
      "  }",
      '  await db.query("update");',
      "  await fetch(url);",
      "  userSchema.parse(input);",
      '  if (user.hasPermission("write")) {',
      "    open = true;",
      "  }",
      "  events.publish(message);",
      "  await db.transaction(async () => {",
      '    await db.query("inside");',
      "  });",
      "}",
      "",
    ].join("\n");
    const head = base
      .replace('await db.query("update");', 'await db.query("changed");')
      .replace("await fetch(url);", "await fetch(nextUrl);")
      .replace("userSchema.parse(input);", "userSchema.parse(nextInput);")
      .replace('user.hasPermission("write")', 'user.hasPermission("admin")')
      .replace("events.publish(message);", "events.publish(nextMessage);")
      .replace('await db.query("inside");', 'await db.query("inside-changed");');
    const needles = [
      'db.query("update")',
      "fetch(url)",
      "userSchema.parse(input)",
      'hasPermission("write")',
      "events.publish(message)",
      'db.query("inside")',
    ];
    const headNeedles = [
      'db.query("changed")',
      "fetch(nextUrl)",
      "userSchema.parse(nextInput)",
      'hasPermission("admin")',
      "events.publish(nextMessage)",
      'db.query("inside-changed")',
    ];
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/save.ts",
        base,
        head,
        needles.map((needle) => line(base, needle)),
        headNeedles.map((needle) => line(head, needle)),
      ),
    );
    assertTraceable(blocks, base, head);
    expect(blocks.some((block) => block.kind === "loop")).toBe(false);
    expect(new Set(blocks.map((block) => block.kind))).toEqual(
      new Set(["database_call", "external_call", "validation", "authorization", "event_publish"]),
    );
    expect(
      blocks.some(
        (block) =>
          block.kind === "database_call" &&
          block.context.some((frame) => frame.kind === "transaction"),
      ),
    ).toBe(true);
    expect(blocks.every((block) => block.confidence === "medium")).toBe(true);
  });

  it("records uncertainty when the patch text is missing", async () => {
    const blocks = await parser.findChangedBlocks(
      changed(
        "src/gap.ts",
        "export function gap() {\n  return 1;\n}\n",
        "export function gap() {\n  return 2;\n}\n",
        [],
        [],
        { patchStatus: "missing", lineMappingComplete: false },
      ),
    );
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "unknown",
        parseStatus: "unmapped",
        confidence: "low",
        baseRange: null,
        headRange: null,
        changedLines: [],
      }),
    ]);
  });

  it("does not parse an ignored path or an unsupported language as a function", async () => {
    const source = "export function hidden() {\n  return 1;\n}\n";
    const ignored = await parser.findChangedBlocks({
      ...changed(
        "dist/hidden.ts",
        source,
        source.replace("return 1", "return 2"),
        [line(source, "return 1")],
        [line(source.replace("return 1", "return 2"), "return 2")],
      ),
      ignore: ["**/dist/**"],
    });
    expect(ignored).toEqual([]);

    const python = "print(1)\n";
    const unsupported = await parser.findChangedBlocks({
      ...changed(
        "src/app.py",
        python,
        "print(2)\n",
        [line(python, "print(1)")],
        [line("print(2)\n", "print(2)")],
      ),
      languages: ["typescript", "javascript"],
    });
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({
      kind: "unknown",
      parseStatus: "unsupported",
      confidence: "low",
      baseRange: null,
      headRange: null,
    });
  });

  it("uses a registered parser for another language", async () => {
    const registry = createParserRegistry();
    registry.register({
      id: "python",
      extensions: { ".py": "python" },
      parse: () => ({
        parseStatus: "parsed",
        nodes: [
          {
            kind: "function",
            name: "greet",
            header: "greet()",
            body: "pass",
            range: { startLine: 1, endLine: 2 },
            enclosingSymbol: null,
            context: [],
            depth: 0,
          },
        ],
      }),
    });
    const base = "def greet():\n    pass\n";
    const head = "def greet():\n    return 1\n";
    const blocks = await createCodeParser(registry).findChangedBlocks(
      changed("src/greet.py", base, head, [line(base, "pass")], [line(head, "return 1")]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "function",
      name: "greet",
      change: "modified",
      parseStatus: "parsed",
      headRange: { startLine: 1, endLine: 2 },
    });
  });

  it("returns the same block ids for the same input", async () => {
    const base = "function stable() {\n  return 1;\n}\n";
    const head = "function stable() {\n  return 2;\n}\n";
    const request = changed(
      "src/stable.ts",
      base,
      head,
      [line(base, "return 1")],
      [line(head, "return 2")],
    );
    const first = await parser.findChangedBlocks(request);
    const second = await parser.findChangedBlocks(request);
    expect(second.map((block) => block.id)).toEqual(first.map((block) => block.id));
    expect(first[0]?.id.startsWith("src/stable.ts#")).toBe(true);
  });
});
