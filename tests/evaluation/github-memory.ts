interface StoredIssue {
  id: number;
  body: string;
  html_url: string;
}

interface StoredReview extends StoredIssue {
  path: string;
  line: number;
  side: string;
}

export interface StoredReviewView {
  readonly path: string;
  readonly line: number;
  readonly side: string;
  readonly body: string;
}

export interface MemoryGitHub {
  readonly fetch: typeof fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  summaryCount(): number;
  summaryBodies(): readonly string[];
  reviews(): readonly StoredReviewView[];
  sleepCount(): number;
}

export function createMemoryGitHub(options?: {
  readonly rateLimitOnce?: boolean;
  readonly failReviewOnce?: boolean;
  readonly forbiddenToken?: string;
}): MemoryGitHub {
  const issues: StoredIssue[] = [];
  const reviews: StoredReview[] = [];
  let nextId = 1;
  let sleeps = 0;
  let limited = false;
  let failedReview = false;

  const fetchImpl: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (options?.forbiddenToken !== undefined) {
      return Promise.resolve(jsonResponse({ message: `rejected ${options.forbiddenToken}` }, 403));
    }
    if (options?.rateLimitOnce === true && !limited) {
      limited = true;
      return Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "0" } }));
    }
    if (method === "GET" && url.includes("/issues/") && url.includes("/comments")) {
      return Promise.resolve(jsonResponse(issues, 200));
    }
    if (method === "GET" && url.includes("/pulls/") && url.includes("/comments")) {
      return Promise.resolve(jsonResponse(reviews, 200));
    }
    if (method === "POST" && url.includes("/issues/") && url.includes("/comments")) {
      const body = readBody(init?.body);
      const comment = storeIssue(
        issues,
        () => {
          nextId += 1;
          return nextId - 1;
        },
        body,
      );
      return Promise.resolve(jsonResponse(comment, 201));
    }
    if (method === "POST" && url.includes("/pulls/") && url.includes("/comments")) {
      if (options?.failReviewOnce === true && !failedReview) {
        failedReview = true;
        return Promise.resolve(jsonResponse({ message: "inline failed" }, 500));
      }
      const body = readBody(init?.body);
      const comment = storeReview(
        reviews,
        () => {
          nextId += 1;
          return nextId - 1;
        },
        body,
      );
      return Promise.resolve(jsonResponse(comment, 201));
    }
    if (method === "PATCH") {
      const id = commentId(url);
      const body = readBody(init?.body);
      const text = typeof body.body === "string" ? body.body : "";
      const issue = issues.find((item) => item.id === id);
      if (issue !== undefined) {
        issue.body = text;
        return Promise.resolve(jsonResponse(issue, 200));
      }
      const review = reviews.find((item) => item.id === id);
      if (review !== undefined) {
        review.body = text;
        return Promise.resolve(jsonResponse(review, 200));
      }
      return Promise.resolve(jsonResponse({ message: "missing comment" }, 404));
    }
    if (method === "DELETE") {
      const id = commentId(url);
      remove(issues, id);
      remove(reviews, id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({ message: "unexpected request" }, 500));
  };

  return {
    fetch: fetchImpl,
    sleep: () => {
      sleeps += 1;
      return Promise.resolve();
    },
    summaryCount: () =>
      issues.filter((issue) => issue.body.includes("review-navigator:summary")).length,
    summaryBodies: () => issues.map((issue) => issue.body),
    reviews: () =>
      reviews.map((review) => ({
        path: review.path,
        line: review.line,
        side: review.side,
        body: review.body,
      })),
    sleepCount: () => sleeps,
  };
}

function storeIssue(
  issues: StoredIssue[],
  allocate: () => number,
  body: Record<string, unknown>,
): StoredIssue {
  const id = allocate();
  const text = typeof body.body === "string" ? body.body : "";
  const comment = {
    id,
    body: text,
    html_url: `https://github.com/example/review-fixtures/pull/15#issuecomment-${id}`,
  };
  issues.push(comment);
  return comment;
}

function storeReview(
  reviews: StoredReview[],
  allocate: () => number,
  body: Record<string, unknown>,
): StoredReview {
  const id = allocate();
  const text = typeof body.body === "string" ? body.body : "";
  const comment = {
    id,
    body: text,
    html_url: `https://github.com/example/review-fixtures/pull/15#discussion_r${id}`,
    path: typeof body.path === "string" ? body.path : "",
    line: typeof body.line === "number" ? body.line : 0,
    side: typeof body.side === "string" ? body.side : "",
  };
  reviews.push(comment);
  return comment;
}

function remove(comments: { id: number }[], id: number): void {
  const index = comments.findIndex((comment) => comment.id === id);
  if (index >= 0) {
    comments.splice(index, 1);
  }
}

function commentId(url: string): number {
  const id = Number(url.split("?")[0]?.split("/").pop());
  return Number.isInteger(id) ? id : 0;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function readBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") {
    return {};
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
