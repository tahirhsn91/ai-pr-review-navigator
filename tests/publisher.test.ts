import { describe, expect, it } from "vitest";

import { GitHubRequestError } from "../src/github/errors.js";
import { publishReviewFocusFromEnv } from "../src/publisher/command.js";
import { createReviewPublisher } from "../src/publisher/publisher.js";
import { SUMMARY_MARKER } from "../src/publisher/render.js";
import type { ReviewFocusReport } from "../src/publisher/types.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const apiBaseUrl = "https://api.github.test";

const report: ReviewFocusReport = {
  pullRequest: { owner: "example", repo: "demo", number: 7 },
  baseSha,
  headSha,
  analysisStatus: "complete",
  overflowCount: 2,
  blocks: [
    {
      blockId: "calc-capture",
      path: "src/billing.ts",
      name: "capture",
      range: { startLine: 4, endLine: 5 },
      blockRange: { startLine: 2, endLine: 6 },
      side: "head",
      reviewReason: "Payment capture now charges twice the previous amount.",
      group: "must_review",
    },
    {
      blockId: "helper",
      path: "src/format.ts",
      name: "label",
      range: { startLine: 2, endLine: 2 },
      blockRange: { startLine: 1, endLine: 4 },
      side: "head",
      reviewReason: "The label text changed for one caller.",
      group: "review_if_relevant",
    },
    {
      blockId: "format-only",
      path: "src/format.ts",
      name: "spacing",
      range: { startLine: 8, endLine: 8 },
      blockRange: { startLine: 8, endLine: 8 },
      side: "head",
      reviewReason: "Formatting and whitespace changed.",
      group: "low_priority",
    },
    {
      blockId: "unknown-change",
      path: "src/adjust.ts",
      name: "adjust",
      range: { startLine: 3, endLine: 3 },
      blockRange: { startLine: 1, endLine: 5 },
      side: "head",
      reviewReason: "Behavior was not assessed.",
      group: "needs_context",
    },
  ],
};

interface StoredIssue {
  id: number;
  body: string;
  html_url: string;
}

interface StoredReview extends StoredIssue {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

function createPullRequestApi(options?: {
  readonly inlineStatus?: number;
  readonly firstStatus?: number;
}): {
  fetch: typeof fetch;
  calls: RecordedCall[];
  issues: StoredIssue[];
  reviews: StoredReview[];
} {
  const calls: RecordedCall[] = [];
  const issues: StoredIssue[] = [];
  const reviews: StoredReview[] = [];
  let nextId = 20;
  let sawFirst = false;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    const body = readBody(init?.body);
    calls.push({ method, url, body });
    if (!sawFirst && options?.firstStatus !== undefined) {
      sawFirst = true;
      return Promise.resolve(
        new Response("busy", { status: options.firstStatus, headers: { "retry-after": "0" } }),
      );
    }
    const pathname = new URL(url).pathname;
    if (method === "GET" && pathname.endsWith("/issues/7/comments")) {
      return json(issues);
    }
    if (method === "POST" && pathname.endsWith("/issues/7/comments")) {
      const created = storeIssue(body);
      return json(created, 201);
    }
    if (method === "PATCH" && pathname.includes("/issues/comments/")) {
      return json(updateIssue(pathname, body));
    }
    if (method === "DELETE" && pathname.includes("/issues/comments/")) {
      removeIssue(pathname);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "GET" && pathname.endsWith("/pulls/7/comments")) {
      return json(reviews);
    }
    if (method === "POST" && pathname.endsWith("/pulls/7/comments")) {
      if (options?.inlineStatus === 422) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
        );
      }
      return json(storeReview(body), 201);
    }
    if (method === "PATCH" && pathname.includes("/pulls/comments/")) {
      return json(updateReview(pathname, body));
    }
    if (method === "DELETE" && pathname.includes("/pulls/comments/")) {
      removeReview(pathname);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("missing", { status: 404 }));
  };

  return { fetch: fetchImpl, calls, issues, reviews };

  function storeIssue(body: unknown): StoredIssue {
    const created = {
      id: nextId,
      body: textField(body),
      html_url: `https://github.com/example/demo/issues/7#issuecomment-${nextId}`,
    };
    nextId += 1;
    issues.push(created);
    return created;
  }

  function storeReview(body: unknown): StoredReview {
    const record = isRecord(body) ? body : {};
    const created: StoredReview = {
      id: nextId,
      body: textField(body),
      html_url: `https://github.com/example/demo/pull/7#discussion_r${nextId}`,
      path: typeof record.path === "string" ? record.path : "",
      line: typeof record.line === "number" ? record.line : 0,
      side: record.side === "LEFT" ? "LEFT" : "RIGHT",
    };
    nextId += 1;
    reviews.push(created);
    return created;
  }

  function updateIssue(pathname: string, body: unknown): StoredIssue {
    const comment = issues.find((item) => item.id === commentId(pathname));
    if (comment === undefined) {
      throw new Error("missing issue comment");
    }
    comment.body = textField(body);
    return comment;
  }

  function updateReview(pathname: string, body: unknown): StoredReview {
    const comment = reviews.find((item) => item.id === commentId(pathname));
    if (comment === undefined) {
      throw new Error("missing review comment");
    }
    comment.body = textField(body);
    return comment;
  }

  function removeIssue(pathname: string): void {
    const id = commentId(pathname);
    const index = issues.findIndex((item) => item.id === id);
    if (index >= 0) {
      issues.splice(index, 1);
    }
  }

  function removeReview(pathname: string): void {
    const id = commentId(pathname);
    const index = reviews.findIndex((item) => item.id === id);
    if (index >= 0) {
      reviews.splice(index, 1);
    }
  }
}

describe("review publishing", () => {
  it("posts a summary and an inline comment on the changed line", async () => {
    const api = createPullRequestApi();
    const receipt = await publish(api.fetch, report);
    const summary = api.issues[0]?.body ?? "";
    expect(summary).toContain(SUMMARY_MARKER);
    expect(summary).toContain("## AI Review Focus");
    expect(summary).toContain(baseSha);
    expect(summary).toContain(headSha);
    expect(summary).toContain("### MUST REVIEW");
    expect(summary).toContain("### REVIEW IF RELEVANT");
    expect(summary).toContain("<details>");
    expect(summary).toContain("### NEEDS CONTEXT");
    expect(summary).toContain("**capture**");
    expect(summary).toContain("src/billing.ts");
    expect(summary).toContain("#L4-L5");
    expect(summary).toContain("Payment capture now charges twice the previous amount.");
    expect(summary).toContain("Priorities indicate review importance, not verified defects.");
    expect(summary).toContain("past the short display budget");
    expect(receipt.updated).toBe(false);
    expect(receipt.inlinePosted).toEqual(["calc-capture"]);
    expect(api.reviews).toEqual([
      expect.objectContaining({
        path: "src/billing.ts",
        line: 4,
        side: "RIGHT",
      }),
    ]);
    expect(api.reviews[0]?.body).toContain("lines 2–6");
    expect(reviewPosts(api.calls)).toHaveLength(1);
    expect(JSON.stringify(api.calls)).not.toContain("APPROVE");
    expect(JSON.stringify(api.calls)).not.toContain("REQUEST_CHANGES");
  });

  it("updates the existing summary and inline comment on a second run", async () => {
    const api = createPullRequestApi();
    await publish(api.fetch, report);
    const firstPosts = api.calls.filter((call) => call.method === "POST").length;
    const receipt = await publish(api.fetch, report);
    expect(receipt.updated).toBe(true);
    expect(receipt.inlineUpdated).toEqual(["calc-capture"]);
    expect(api.issues).toHaveLength(1);
    expect(api.reviews).toHaveLength(1);
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(firstPosts);
    expect(api.calls.filter((call) => call.method === "PATCH").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps an invalid inline anchor in the summary and does not try another line", async () => {
    const api = createPullRequestApi({ inlineStatus: 422 });
    const receipt = await publish(api.fetch, report);
    expect(receipt.inlineSummaryOnly).toEqual(["calc-capture"]);
    expect(reviewPosts(api.calls)).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          line: 4,
          side: "RIGHT",
          path: "src/billing.ts",
        }) as unknown,
      }),
    ]);
    expect(api.reviews).toHaveLength(0);
    expect(api.issues[0]?.body).toContain("**capture**");
    expect(api.issues[0]?.body).toContain("#L4-L5");
    expect(api.issues[0]?.body).toContain("Payment capture now charges twice the previous amount.");
  });

  it("removes a stale inline comment and a duplicate summary", async () => {
    const api = createPullRequestApi();
    api.issues.push(
      {
        id: 1,
        body: `${SUMMARY_MARKER}\nold`,
        html_url: "https://github.com/example/demo/issues/7#issuecomment-1",
      },
      {
        id: 2,
        body: `${SUMMARY_MARKER}\nolder`,
        html_url: "https://github.com/example/demo/issues/7#issuecomment-2",
      },
    );
    api.reviews.push({
      id: 3,
      body: "<!-- review-navigator:inline old-block -->\nstale",
      html_url: "https://github.com/example/demo/pull/7#discussion_r3",
      path: "src/old.ts",
      line: 9,
      side: "RIGHT",
    });
    const receipt = await publish(api.fetch, report);
    expect(receipt.updated).toBe(true);
    expect(receipt.inlineRemoved).toContain("old-block");
    expect(api.issues).toHaveLength(1);
    expect(api.issues[0]?.id).toBe(1);
    expect(api.reviews.map((comment) => comment.path)).toEqual(["src/billing.ts"]);
    expect(
      api.calls.filter((call) => call.method === "POST" && call.url.includes("/issues/")),
    ).toHaveLength(0);
  });

  it("reports a missing permission without the token", async () => {
    const token = ["test", "token", "value"].join("-");
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: `denied for ${token}` }), {
          status: 403,
        }),
      );
    const error = await createReviewPublisher({
      token,
      apiBaseUrl,
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    })
      .publish(report)
      .then(() => {
        throw new Error("expected a failure");
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubRequestError);
    if (error instanceof Error) {
      expect(error.message).toContain("403");
      expect(error.message).not.toContain(token);
    }
  });

  it("retries a rate limit and then publishes", async () => {
    const api = createPullRequestApi({ firstStatus: 429 });
    const receipt = await publish(api.fetch, report);
    expect(receipt.commentId).toBeGreaterThan(0);
    expect(api.issues).toHaveLength(1);
  });

  it("does not call GitHub when the report is invalid", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response("[]", { status: 200 }));
    };
    const publisher = createReviewPublisher({
      token: "test-token",
      apiBaseUrl,
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });
    await expect(publisher.publish({ ...report, headSha: "short" })).rejects.toThrow(
      /publishing schema/,
    );
    expect(calls).toBe(0);
  });

  it("names a missing publish variable and leaves its value out", async () => {
    await expect(publishReviewFocusFromEnv({})).rejects.toThrow(/GITHUB_TOKEN is not set/);
  });
});

function publish(fetchImpl: typeof fetch, input: ReviewFocusReport) {
  return createReviewPublisher({
    token: "test-token",
    apiBaseUrl,
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
  }).publish(input);
}

function reviewPosts(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method === "POST" && call.url.includes("/pulls/7/comments"));
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
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

function readBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return undefined;
  }
  return JSON.parse(body) as unknown;
}

function textField(body: unknown): string {
  return isRecord(body) && typeof body.body === "string" ? body.body : "";
}

function commentId(pathname: string): number {
  const id = pathname.split("/").pop();
  return Number(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
