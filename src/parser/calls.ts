import type { StructuralKind } from "./types.js";

export function classifyCallee(callee: string): StructuralKind | undefined {
  const compact = callee.replace(/\s+/gu, "");
  if (/(?:^|\.)(?:transaction|beginTransaction)$/u.test(compact)) {
    return "transaction";
  }
  if (/(?:^|\.)(?:publish|emit|dispatch)$/u.test(compact)) {
    return "event_publish";
  }
  if (/(?:^|\.)(?:validate|safeParse)$/u.test(compact) || /schema\.parse$/iu.test(compact)) {
    return "validation";
  }
  if (isAuthorizationCallee(compact)) {
    return "authorization";
  }
  if (
    compact === "fetch" ||
    /^(?:axios|got)(?:\.|$)/u.test(compact) ||
    /^(?:http|https)\.request$/u.test(compact)
  ) {
    return "external_call";
  }
  if (isDatabaseCallee(compact)) {
    return "database_call";
  }
  return undefined;
}

export function isAuthorizationText(text: string): boolean {
  return (
    /(?:^|[.\s(])(?:authorize|isAllowed|hasPermission|requireAuth|assertAdmin)(?:$|[.\s(])/u.test(
      text,
    ) || /(?:^|[.\s(])can(?:$|[.\s(])/u.test(text)
  );
}

export function isValidationText(text: string): boolean {
  return (
    /(?:^|[.\s(])(?:validate|safeParse)(?:$|[.\s(])/u.test(text) ||
    /schema\.parse\s*\(/iu.test(text)
  );
}

function isAuthorizationCallee(callee: string): boolean {
  return (
    /(?:^|\.)(?:authorize|isAllowed|hasPermission|requireAuth|assertAdmin)$/u.test(callee) ||
    /(?:^|\.)can$/u.test(callee)
  );
}

function isDatabaseCallee(callee: string): boolean {
  const parts = callee.split(".");
  const method = parts.at(-1);
  if (method === undefined || parts.length < 2) {
    return false;
  }
  if (
    !/^(?:query|execute|findMany|findFirst|findUnique|findOne|insert|insertOne|update|updateOne|delete|deleteOne|deleteMany|upsert|save)$/u.test(
      method,
    )
  ) {
    return false;
  }
  return parts
    .slice(0, -1)
    .some((part) => /^(?:db|prisma|knex|pool|client|repository|repo|em|manager)$/iu.test(part));
}
