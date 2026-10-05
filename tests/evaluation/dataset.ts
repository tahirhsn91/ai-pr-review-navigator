import type { AnalysisConfidence, BusinessImpact } from "../../src/analysis/types.js";
import type { PullRequestFileStatus } from "../../src/github/types.js";

export type LabelRole = "important" | "not_important" | "uncertain";

export interface EvalLabel {
  readonly id: string;
  readonly side: "base" | "head";
  readonly needle: string;
  readonly role: LabelRole;
  readonly category: string;
}

export interface EvalCard {
  readonly includes: string;
  readonly behaviorChanged: boolean;
  readonly businessImpact: BusinessImpact;
  readonly reviewReason: string;
  readonly evidence: readonly string[];
  readonly confidence: AnalysisConfidence;
}

export interface EvalFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: PullRequestFileStatus;
  readonly base: string | null;
  readonly head: string | null;
  readonly withholdPatch: boolean;
  readonly labels: readonly EvalLabel[];
  readonly cards: readonly EvalCard[];
}

export const REQUIRED_CATEGORIES = [
  "business-calculation",
  "authorization",
  "database-mutation",
  "transaction",
  "loop-state",
  "repeated-operation",
  "api-contract",
  "rename",
  "formatting",
  "type-only",
  "test-only",
  "mechanical-refactor",
  "missing-context",
  "parser-failure",
  "unsupported-language",
  "deleted-file",
  "renamed-file",
] as const;

function source(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function card(
  includes: string,
  behaviorChanged: boolean,
  businessImpact: BusinessImpact,
  reviewReason: string,
  evidence: string,
  confidence: AnalysisConfidence,
): EvalCard {
  return {
    includes,
    behaviorChanged,
    businessImpact,
    reviewReason,
    evidence: [evidence],
    confidence,
  };
}

export function labeledDataset(): readonly EvalFile[] {
  return [
    {
      path: "src/billing.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "export function capture(amount: number): number {",
        "  return amount * 1;",
        "}",
      ]),
      head: source([
        "export function capture(amount: number): number {",
        "  return amount * 2;",
        "}",
      ]),
      labels: [
        {
          id: "billing-charge",
          side: "head",
          needle: "amount * 2",
          role: "important",
          category: "business-calculation",
        },
      ],
      cards: [
        card(
          "amount * 2",
          true,
          "critical",
          "Payment capture now doubles the amount a customer is charged.",
          "return amount * 2",
          "high",
        ),
      ],
    },
    {
      path: "src/access.ts",
      previousPath: "src/old-access.ts",
      status: "renamed",
      withholdPatch: false,
      base: source([
        "export function openAccount(role: string): boolean {",
        '  return role === "member";',
        "}",
      ]),
      head: source([
        "export function openAccount(role: string): boolean {",
        "  return authorize(role);",
        "}",
        "",
        "function authorize(role: string): boolean {",
        '  return role === "admin";',
        "}",
      ]),
      labels: [
        {
          id: "access-check",
          side: "head",
          needle: "authorize(role)",
          role: "important",
          category: "authorization",
        },
        {
          id: "access-admin",
          side: "head",
          needle: 'role === "admin"',
          role: "important",
          category: "renamed-file",
        },
      ],
      cards: [
        card(
          "authorize(role)",
          true,
          "significant",
          "Opening an account now calls authorize before access is granted.",
          "return authorize(role)",
          "high",
        ),
        card(
          'role === "admin"',
          true,
          "significant",
          "The new authorize function grants access only to an admin role.",
          'return role === "admin"',
          "high",
        ),
      ],
    },
    {
      path: "src/account-store.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "export async function saveName(",
        "  db: { update(query: string): Promise<void> },",
        "  id: string,",
        "): Promise<void> {",
        "  await db.update(id);",
        "}",
      ]),
      head: source([
        "export async function saveName(",
        "  db: { update(query: string): Promise<void> },",
        "  id: string,",
        "): Promise<void> {",
        "  await db.update(`account:${id}`);",
        "}",
      ]),
      labels: [
        {
          id: "account-key",
          side: "head",
          needle: "account:${id}",
          role: "important",
          category: "database-mutation",
        },
      ],
      cards: [
        card(
          "account:${id}",
          true,
          "significant",
          "The database update now writes an account key instead of the raw id.",
          "account:${id}",
          "high",
        ),
      ],
    },
    {
      path: "src/transfer.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "export async function transfer(db: {",
        "  transaction(work: () => Promise<void>): Promise<void>;",
        "  update(query: string): Promise<void>;",
        "}): Promise<void> {",
        '  await db.update("from");',
        '  await db.update("to");',
        "}",
      ]),
      head: source([
        "export async function transfer(db: {",
        "  transaction(work: () => Promise<void>): Promise<void>;",
        "  update(query: string): Promise<void>;",
        "}): Promise<void> {",
        "  await db.transaction(async () => {",
        '    await db.update("from");',
        '    await db.update("to");',
        "  });",
        "}",
      ]),
      labels: [
        {
          id: "transfer-transaction",
          side: "head",
          needle: "db.transaction",
          role: "important",
          category: "transaction",
        },
      ],
      cards: [
        card(
          "db.transaction",
          true,
          "significant",
          "The balance updates now run inside a database transaction.",
          "db.transaction",
          "high",
        ),
      ],
    },
    {
      path: "src/accrue.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "function next(total: number, value: number): number {",
        "  return total + value;",
        "}",
        "",
        "export function accrue(values: number[]): number {",
        "  let total = 0;",
        "  for (const value of values) {",
        "    total = next(total, value);",
        "  }",
        "  return total;",
        "}",
      ]),
      head: source([
        "function next(total: number, value: number): number {",
        "  return total + value;",
        "}",
        "",
        "export function accrue(values: number[]): number {",
        "  let total = 0;",
        "  for (const value of values) {",
        "    total = next(value, total);",
        "  }",
        "  return total;",
        "}",
      ]),
      labels: [
        {
          id: "accrue-loop",
          side: "head",
          needle: "next(value, total)",
          role: "important",
          category: "loop-state",
        },
      ],
      cards: [
        card(
          "next(value, total)",
          true,
          "significant",
          "The loop now passes the arguments to next in the opposite order, so the accumulated total changes.",
          "next(value, total)",
          "high",
        ),
      ],
    },
    {
      path: "src/render-rows.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "export function renderRows(rows: string[]): string[] {",
        "  const out: string[] = [];",
        "  for (const row of rows) {",
        "    out.push(row);",
        "  }",
        "  return out;",
        "}",
      ]),
      head: source([
        "export function renderRows(rows: string[]): string[] {",
        "  const out: string[] = [];",
        "  for (const row of rows) {",
        "    out.push(row.trim().toLowerCase());",
        "  }",
        "  return out;",
        "}",
      ]),
      labels: [
        {
          id: "render-loop",
          side: "head",
          needle: "toLowerCase()",
          role: "important",
          category: "repeated-operation",
        },
      ],
      cards: [
        card(
          "toLowerCase()",
          true,
          "limited",
          "Each row is now trimmed and lowercased on every pass through the loop.",
          "row.trim().toLowerCase()",
          "high",
        ),
      ],
    },
    {
      path: "src/quote.ts",
      status: "modified",
      withholdPatch: false,
      base: source(["export function quote(amount: number): number {", "  return amount;", "}"]),
      head: source([
        "export function quote(amount: number, currency: string): number {",
        "  return amount;",
        "}",
      ]),
      labels: [
        {
          id: "quote-signature",
          side: "head",
          needle: "currency: string",
          role: "important",
          category: "api-contract",
        },
      ],
      cards: [
        card(
          "currency: string",
          true,
          "significant",
          "The exported quote function now requires a currency argument.",
          "currency: string",
          "high",
        ),
      ],
    },
    {
      path: "src/label.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "export function label(name: string): string {",
        "  const title = name;",
        "  return title;",
        "}",
      ]),
      head: source([
        "export function label(name: string): string {",
        "  const heading = name;",
        "  return heading;",
        "}",
      ]),
      labels: [
        {
          id: "label-rename",
          side: "head",
          needle: "const heading",
          role: "not_important",
          category: "rename",
        },
      ],
      cards: [
        card(
          "const heading",
          false,
          "none",
          "The local title binding was renamed to heading and the returned text is unchanged.",
          "const heading = name",
          "high",
        ),
      ],
    },
    {
      path: "src/spacing.ts",
      status: "modified",
      withholdPatch: false,
      base: source(["export function space(value: string): string {", "  return value;", "}"]),
      head: source(["export function space(value: string): string {", "  return  value;", "}"]),
      labels: [
        {
          id: "spacing-whitespace",
          side: "head",
          needle: "return  value",
          role: "not_important",
          category: "formatting",
        },
      ],
      cards: [
        card(
          "return  value",
          false,
          "none",
          "Whitespace in the return expression changed and the returned text is unchanged.",
          "return  value",
          "high",
        ),
      ],
    },
    {
      path: "src/pixels.ts",
      status: "modified",
      withholdPatch: false,
      base: source(["export function width(value: number): number {", "  return value;", "}"]),
      head: source([
        "type Pixels = number;",
        "",
        "export function width(value: Pixels): number {",
        "  return value;",
        "}",
      ]),
      labels: [
        {
          id: "pixels-alias",
          side: "head",
          needle: "value: Pixels",
          role: "not_important",
          category: "type-only",
        },
      ],
      cards: [
        card(
          "value: Pixels",
          false,
          "none",
          "The parameter annotation now uses the Pixels alias and the returned number is unchanged.",
          "value: Pixels",
          "high",
        ),
      ],
    },
    {
      path: "tests/charge.test.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        'import { capture } from "../src/billing.js";',
        "",
        'test("charge", () => {',
        "  expect(capture(10)).toBe(10);",
        "});",
      ]),
      head: source([
        'import { capture } from "../src/billing.js";',
        "",
        'test("charge", () => {',
        "  expect(capture(10)).toBe(20);",
        "});",
      ]),
      labels: [
        {
          id: "charge-expectation",
          side: "head",
          needle: "toBe(20)",
          role: "important",
          category: "test-only",
        },
      ],
      cards: [
        card(
          "toBe(20)",
          true,
          "limited",
          "The test now expects capture(10) to equal 20.",
          "toBe(20)",
          "high",
        ),
      ],
    },
    {
      path: "tests/spacing.test.ts",
      status: "modified",
      withholdPatch: false,
      base: source(['test("spacing", () => {', "  expect(1).toBe(1);", "});"]),
      head: source(['test("spacing", () => {', "  expect(1).toBe( 1 );", "});"]),
      labels: [
        {
          id: "spacing-test",
          side: "head",
          needle: "toBe( 1 )",
          role: "not_important",
          category: "test-only",
        },
      ],
      cards: [
        card(
          "toBe( 1 )",
          false,
          "none",
          "Whitespace inside the assertion changed and the expected value is unchanged.",
          "toBe( 1 )",
          "high",
        ),
      ],
    },
    {
      path: "src/mechanical.ts",
      status: "modified",
      withholdPatch: false,
      base: source([
        "export function alpha(value: string): string {",
        "  return value;",
        "}",
        "",
        "export function beta(value: string): string {",
        "  return value;",
        "}",
        "",
        "export function gamma(value: string): string {",
        "  return value;",
        "}",
      ]),
      head: source([
        "export function alpha(input: string): string {",
        "  return input;",
        "}",
        "",
        "export function beta(input: string): string {",
        "  return input;",
        "}",
        "",
        "export function gamma(input: string): string {",
        "  return input;",
        "}",
      ]),
      labels: [
        {
          id: "mechanical-alpha",
          side: "head",
          needle: "function alpha(input",
          role: "not_important",
          category: "mechanical-refactor",
        },
        {
          id: "mechanical-beta",
          side: "head",
          needle: "function beta(input",
          role: "not_important",
          category: "mechanical-refactor",
        },
        {
          id: "mechanical-gamma",
          side: "head",
          needle: "function gamma(input",
          role: "not_important",
          category: "mechanical-refactor",
        },
      ],
      cards: [
        card(
          "(input: string)",
          false,
          "none",
          "A parameter was renamed from value to input and the returned text is unchanged.",
          "input: string",
          "high",
        ),
      ],
    },
    {
      path: "src/unmapped-fee.ts",
      status: "modified",
      withholdPatch: true,
      base: source(["export function fee(amount: number): number {", "  return amount + 1;", "}"]),
      head: source(["export function fee(amount: number): number {", "  return amount + 5;", "}"]),
      labels: [
        {
          id: "unmapped-fee",
          side: "head",
          needle: "amount + 5",
          role: "uncertain",
          category: "missing-context",
        },
      ],
      cards: [],
    },
    {
      path: "src/broken.ts",
      status: "modified",
      withholdPatch: false,
      base: source(["export function broken(value: number): number {", "  return value + 1;", "}"]),
      head: source(["export function broken(value: number): number {", "  return value +", "}"]),
      labels: [
        {
          id: "broken-parse",
          side: "head",
          needle: "return value +",
          role: "uncertain",
          category: "parser-failure",
        },
      ],
      cards: [
        card(
          "return value +",
          false,
          "none",
          "The return expression is unfinished and the stand-in treats the behavior as unchanged.",
          "return value +",
          "high",
        ),
      ],
    },
    {
      path: "src/notes.py",
      status: "modified",
      withholdPatch: false,
      base: source(["print(1)"]),
      head: source(["print(2)"]),
      labels: [
        {
          id: "notes-python",
          side: "head",
          needle: "print(2)",
          role: "uncertain",
          category: "unsupported-language",
        },
      ],
      cards: [],
    },
    {
      path: "src/legacy-fee.ts",
      status: "removed",
      withholdPatch: false,
      base: source([
        "export function legacyFee(amount: number): number {",
        "  return amount * 3;",
        "}",
      ]),
      head: null,
      labels: [
        {
          id: "legacy-fee",
          side: "base",
          needle: "amount * 3",
          role: "important",
          category: "deleted-file",
        },
      ],
      cards: [
        card(
          "amount * 3",
          true,
          "critical",
          "The legacy fee calculation was removed, so a customer is no longer charged this amount.",
          "amount * 3",
          "high",
        ),
      ],
    },
  ];
}

export function bulkRename(index: number): EvalFile {
  return {
    path: `src/bulk/item-${index}.ts`,
    status: "modified",
    withholdPatch: false,
    base: source([`export function item${index}(value: string): string {`, "  return value;", "}"]),
    head: source([`export function item${index}(input: string): string {`, "  return input;", "}"]),
    labels: [],
    cards: [
      card(
        "(input: string)",
        false,
        "none",
        "A parameter was renamed from value to input and the returned text is unchanged.",
        "input: string",
        "high",
      ),
    ],
  };
}
