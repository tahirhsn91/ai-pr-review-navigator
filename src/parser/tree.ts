import ts from "typescript";

import { classifyCallee, isAuthorizationText, isValidationText } from "./calls.js";
import type {
  EnclosingFrame,
  LanguageSyntaxParser,
  StructuralKind,
  SyntaxNode,
  SyntaxTree,
} from "./types.js";
import type { LineRange } from "../shared/location.js";

interface Scope extends EnclosingFrame {
  readonly symbol: string;
}

const ARITHMETIC = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
]);

export function createTypeScriptSyntaxParser(): LanguageSyntaxParser {
  return {
    id: "typescript-javascript",
    extensions: {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    parse(input) {
      try {
        return parseSource(input.path, input.text);
      } catch {
        return { parseStatus: "partial", nodes: [] };
      }
    },
  };
}

function parseSource(path: string, text: string): SyntaxTree {
  const scriptKind = scriptKindFor(path);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind);
  const nodes: SyntaxNode[] = [];
  const walk = (node: ts.Node, scopes: readonly Scope[]): void => {
    const recognized = recognize(source, node, scopes);
    if (recognized?.node) {
      nodes.push(recognized.node);
    }
    const next = recognized?.scope === undefined ? scopes : [...scopes, recognized.scope];
    ts.forEachChild(node, (child) => {
      walk(child, next);
    });
  };
  walk(source, []);
  return { parseStatus: syntaxStatus(path, text, scriptKind), nodes };
}

interface Recognized {
  readonly node?: SyntaxNode;
  readonly scope?: Scope;
}

function recognize(
  source: ts.SourceFile,
  node: ts.Node,
  scopes: readonly Scope[],
): Recognized | undefined {
  if (isFunctionLike(node)) {
    return recognizeFunction(source, node, scopes);
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return recognizeClass(source, node, scopes);
  }
  if (ts.isIfStatement(node)) {
    return recognizeIf(source, node, scopes);
  }
  if (isLoop(node)) {
    return recognizeLoop(source, node, scopes);
  }
  if (ts.isTryStatement(node)) {
    return { scope: makeScope(scopes, "exception_handler", "try", rangeOfNode(source, node)) };
  }
  if (ts.isCatchClause(node)) {
    return recognizeCatch(source, node, scopes);
  }
  if (isFinallyBlock(node)) {
    return recognizeNamed(source, node, scopes, "exception_handler", "finally", "finally");
  }
  if (ts.isReturnStatement(node)) {
    const header = node.expression === undefined ? "return" : node.expression.getText(source);
    return recognizeNamed(source, node, scopes, "return", shorten(header), header);
  }
  if (isOuterCalculation(node)) {
    const header = node.getText(source);
    return { node: makeNode(source, node, scopes, "calculation", shorten(header), header, header) };
  }
  if (ts.isCallExpression(node)) {
    return recognizeCall(source, node, scopes);
  }
  return undefined;
}

function recognizeFunction(
  source: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
  scopes: readonly Scope[],
): Recognized {
  const kind = functionKind(node);
  const name = functionName(source, node);
  const params = parameterNames(source, node);
  const header = `${name}(${params})`;
  const body = `${params} ${node.body?.getText(source) ?? ""}`;
  const range = rangeOfNode(source, node);
  return {
    node: makeNode(source, node, scopes, kind, name, header, body),
    scope: makeScope(scopes, kind, name, range),
  };
}

function recognizeClass(
  source: ts.SourceFile,
  node: ts.ClassDeclaration | ts.ClassExpression,
  scopes: readonly Scope[],
): Recognized {
  const name = node.name?.text ?? "anonymous";
  return recognizeNamed(source, node, scopes, "class", name, name);
}

function recognizeIf(
  source: ts.SourceFile,
  node: ts.IfStatement,
  scopes: readonly Scope[],
): Recognized {
  const header = node.expression.getText(source);
  const kind = branchKind(header);
  return recognizeNamed(source, node, scopes, kind, shorten(header), header);
}

function recognizeLoop(source: ts.SourceFile, node: ts.Node, scopes: readonly Scope[]): Recognized {
  const header = loopHeader(source, node);
  return recognizeNamed(source, node, scopes, "loop", shorten(header), header);
}

function recognizeCatch(
  source: ts.SourceFile,
  node: ts.CatchClause,
  scopes: readonly Scope[],
): Recognized {
  const name = node.variableDeclaration?.name.getText(source) ?? "catch";
  return recognizeNamed(source, node, scopes, "exception_handler", name, `catch (${name})`);
}

function recognizeNamed(
  source: ts.SourceFile,
  node: ts.Node,
  scopes: readonly Scope[],
  kind: StructuralKind,
  name: string,
  header: string,
): Recognized {
  const range = rangeOfNode(source, node);
  return {
    node: makeNode(source, node, scopes, kind, name, header, node.getText(source)),
    scope: makeScope(scopes, kind, name, range),
  };
}

function recognizeCall(
  source: ts.SourceFile,
  node: ts.CallExpression,
  scopes: readonly Scope[],
): Recognized | undefined {
  const callee = node.expression.getText(source);
  const kind = classifyCallee(callee);
  if (kind === undefined) {
    return undefined;
  }
  const header = node.getText(source);
  if (kind === "transaction") {
    return {
      node: makeNode(
        source,
        node,
        scopes,
        kind,
        shorten(callee),
        header,
        header,
        transactionHeaderRange(source, node),
      ),
      scope: makeScope(scopes, kind, shorten(callee), rangeOfNode(source, node)),
    };
  }
  const statement = ts.isAwaitExpression(node.parent) ? node.parent : node;
  return {
    node: makeNode(source, statement, scopes, kind, shorten(callee), header, header),
  };
}

function makeNode(
  source: ts.SourceFile,
  node: ts.Node,
  scopes: readonly Scope[],
  kind: StructuralKind,
  name: string,
  header: string,
  body: string,
  range: LineRange = rangeOfNode(source, node),
): SyntaxNode {
  return {
    kind,
    name,
    header,
    body,
    range,
    enclosingSymbol: nearestSymbol(scopes),
    context: scopes.map((scope) => ({ kind: scope.kind, name: scope.name, range: scope.range })),
    depth: scopes.length,
  };
}

function makeScope(
  scopes: readonly Scope[],
  kind: StructuralKind,
  name: string,
  range: LineRange,
): Scope {
  const symbolName = kind === "function" || kind === "method" || kind === "class" ? name : "";
  const parent = nearestSymbol(scopes);
  const symbol =
    symbolName.length === 0
      ? (parent ?? "")
      : parent === null
        ? symbolName
        : `${parent}.${symbolName}`;
  return { kind, name, range, symbol };
}

function nearestSymbol(scopes: readonly Scope[]): string | null {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (
      scope !== undefined &&
      (scope.kind === "function" || scope.kind === "method" || scope.kind === "class") &&
      scope.symbol.length > 0
    ) {
      return scope.symbol;
    }
  }
  return null;
}

function branchKind(header: string): "conditional" | "authorization" | "validation" {
  if (isAuthorizationText(header)) {
    return "authorization";
  }
  if (isValidationText(header)) {
    return "validation";
  }
  return "conditional";
}

function functionKind(node: ts.FunctionLikeDeclaration): "function" | "method" {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    return "method";
  }
  return "function";
}

function functionName(source: ts.SourceFile, node: ts.FunctionLikeDeclaration): string {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (node.name !== undefined) {
    return shorten(node.name.getText(source));
  }
  return bindingName(node.parent) ?? "anonymous";
}

function bindingName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left)
  ) {
    return node.left.text;
  }
  return undefined;
}

function parameterNames(source: ts.SourceFile, node: ts.FunctionLikeDeclaration): string {
  return node.parameters
    .map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source),
    )
    .join(", ");
}

function loopHeader(source: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(source);
  const brace = text.indexOf("{");
  return brace === -1 ? text : text.slice(0, brace).trim();
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isFinallyBlock(node: ts.Node): boolean {
  return (
    ts.isBlock(node) &&
    node.parent !== undefined &&
    ts.isTryStatement(node.parent) &&
    node.parent.finallyBlock === node
  );
}

function isOuterCalculation(node: ts.Node): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node) || !ARITHMETIC.has(node.operatorToken.kind)) {
    return false;
  }
  return !(
    node.parent !== undefined &&
    ts.isBinaryExpression(node.parent) &&
    ARITHMETIC.has(node.parent.operatorToken.kind)
  );
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function transactionHeaderRange(source: ts.SourceFile, call: ts.CallExpression): LineRange {
  const callback = call.arguments.find((argument) => isFunctionLike(argument));
  if (callback === undefined) {
    return rangeOfNode(source, call);
  }
  return rangeBetween(source, call.getStart(source), callback.getStart(source));
}

function rangeOfNode(source: ts.SourceFile, node: ts.Node): LineRange {
  return rangeBetween(source, node.getStart(source), node.getEnd());
}

function rangeBetween(source: ts.SourceFile, start: number, endExclusive: number): LineRange {
  const last = Math.max(0, source.text.length - 1);
  const safeStart = Math.min(Math.max(0, start), last);
  const safeEnd = Math.min(Math.max(safeStart, endExclusive - 1), last);
  const startLine = source.getLineAndCharacterOfPosition(safeStart).line + 1;
  const endLine = source.getLineAndCharacterOfPosition(safeEnd).line + 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

function shorten(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 120 ? normalized.slice(0, 120) : normalized;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (path.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function syntaxStatus(path: string, text: string, scriptKind: ts.ScriptKind): "parsed" | "partial" {
  try {
    return syntaxErrorCount(path, text, scriptKind) > 0 ? "partial" : "parsed";
  } catch {
    return "partial";
  }
}

function syntaxErrorCount(path: string, text: string, scriptKind: ts.ScriptKind): number {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.Latest,
    jsx:
      scriptKind === ts.ScriptKind.TSX || scriptKind === ts.ScriptKind.JSX
        ? ts.JsxEmit.Preserve
        : ts.JsxEmit.None,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) =>
      fileName === path
        ? ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind)
        : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => fileName === path,
    readFile: (fileName) => (fileName === path ? text : undefined),
  };
  const program = ts.createProgram([path], options, host);
  const source = program.getSourceFile(path);
  if (source === undefined) {
    return 1;
  }
  return program.getSyntacticDiagnostics(source).length;
}
