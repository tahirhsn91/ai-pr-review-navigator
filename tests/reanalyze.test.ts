import { describe, expect, it } from "vitest";

import { reanalyzeProcessEnv, reanalyzePullRequest } from "../src/pipeline.js";
import { GitHubRequestError } from "../src/github/errors.js";
import type {
  FileContentResult,
  GitHubClient,
  PullRequestFile,
  PullRequestSnapshot,
} from "../src/github/types.js";
import { LlmRequestError } from "../src/llm/errors.js";
import type { LlmProvider } from "../src/llm/types.js";
import { INCOMPLETE_MARKER, SUMMARY_MARKER, renderSummary } from "../src/publisher/render.js";
import type { PublishReceipt, ReviewFocusReport, ReviewPublisher } from "../src/publisher/types.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEXT = "c".repeat(40);

const baseSource = [
  "export function capture(amount: number): number {",
  "  return amount * 1;",
  "}",
  "",
].join("\n");
const headSource = [
  "export function capture(amount: number): number {",
  "  return amount * 2;",
  "}",
  "",
].join("\n");
const billingPatch = [
  "@@ -1,3 +1,3 @@",
  " export function capture(amount: number): number {",
  "-  return amount * 1;",
  "+  return amount * 2;",
  " }",
  "",
].join("\n");

const env = {
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORY: "acme/demo",
  REVIEW_PULL_REQUEST: "4",
  LLM_PROVIDER: "none",
};

function text(value: string): FileContentResult {
  return { status: "present", text: value, byteLength: Buffer.byteLength(value) };
}

function snapshot(headSha: string, files: readonly PullRequestFile[]): PullRequestSnapshot {
  return {
    ref: { owner: "acme", repo: "demo", number: 4 },
    title: "Adjust capture",
    baseSha: BASE,
    headSha,
    files,
  };
}

function clientFor(
  files: readonly PullRequestFile[],
  contents: ReadonlyMap<string, FileContentResult>,
  heads: readonly string[] = [HEAD, HEAD],
): GitHubClient {
  let fetches = 0;
  return {
    fetchPullRequest(): Promise<PullRequestSnapshot> {
      const headSha = heads[Math.min(fetches, heads.length - 1)] ?? HEAD;
      fetches += 1;
      return Promise.resolve(snapshot(headSha, files));
    },
    fetchFileText(): Promise<string> {
      return Promise.reject(new Error("unused"));
    },
    fetchFileContent(request): Promise<FileContentResult> {
      const content = contents.get(`${request.sha}:${request.path}`);
      if (content === undefined) {
        return Promise.reject(new Error(`missing content for ${request.sha}:${request.path}`));
      }
      return Promise.resolve(content);
    },
  };
}

function billingClient(heads?: readonly string[]): GitHubClient {
  return clientFor(
    [
      {
        filename: "src/billing.ts",
        status: "modified",
        patch: billingPatch,
        additions: 1,
        deletions: 1,
      },
    ],
    new Map([
      [`${BASE}:src/billing.ts`, text(baseSource)],
      [`${HEAD}:src/billing.ts`, text(headSource)],
    ]),
    heads,
  );
}

function recordingPublisher(): ReviewPublisher & { readonly reports: ReviewFocusReport[] } {
  const reports: ReviewFocusReport[] = [];
  return {
    reports,
    publish(report): Promise<PublishReceipt> {
      reports.push(report);
      return Promise.resolve({
        commentId: 1,
        url: "https://example.test/comment",
        updated: reports.length > 1,
        inlinePosted: [],
        inlineUpdated: [],
        inlineRemoved: [],
        inlineSummaryOnly: [],
      });
    },
  };
}

function chargingModel(): LlmProvider {
  return {
    provider: "claude",
    model: "test-model",
    complete(request) {
      const line = request.user.split("\n").find((item) => item.startsWith("candidate: "));
      const blockId = line === undefined ? "" : line.slice("candidate: ".length);
      return Promise.resolve({
        text: JSON.stringify({
          blockId,
          behaviorChanged: true,
          businessImpact: "critical",
          reviewReason: "Payment capture now doubles the amount a customer is charged.",
          evidence: ["return amount * 2"],
          contextRequired: [],
          confidence: "high",
          uncertaintyReasons: [],
        }),
      });
    },
    explainAttention() {
      return Promise.reject(new Error("unused"));
    },
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reanalyze pull request", () => {
  it("publishes the blocks for the analyzed head SHA", async () => {
    const publisher = recordingPublisher();
    const result = await reanalyzePullRequest({
      env,
      client: billingClient(),
      publisher,
      model: chargingModel(),
    });

    expect(result).toEqual({
      outcome: "published",
      baseSha: BASE,
      headSha: HEAD,
      analysisStatus: "complete",
    });
    const report = publisher.reports[0];
    expect(report?.headSha).toBe(HEAD);
    expect(report?.blocks.some((block) => block.group === "must_review")).toBe(true);
    if (report !== undefined) {
      expect(renderSummary(report)).toContain(`Head: \`${HEAD}\``);
      expect(renderSummary(report)).toContain("Status: complete");
    }
  });

  it("discards a run when the head SHA moves before publishing", async () => {
    const publisher = recordingPublisher();
    const result = await reanalyzePullRequest({
      env,
      client: billingClient([HEAD, NEXT]),
      publisher,
      model: chargingModel(),
    });

    expect(result).toEqual({ outcome: "stale", baseSha: BASE, headSha: HEAD });
    expect(publisher.reports).toEqual([]);
  });

  it("publishes uncertain blocks when the model request fails", async () => {
    const publisher = recordingPublisher();
    const model: LlmProvider = {
      ...chargingModel(),
      complete() {
        return Promise.reject(new LlmRequestError("The model request timed out."));
      },
    };
    const result = await reanalyzePullRequest({
      env,
      client: billingClient(),
      publisher,
      model,
    });

    expect(result.outcome).toBe("published");
    expect(result.analysisStatus).toBe("unavailable");
    expect(result.headSha).toBe(HEAD);
    const report = publisher.reports[0];
    expect(report?.blocks.length).toBeGreaterThan(0);
    expect(report?.blocks.every((block) => block.group === "needs_context")).toBe(true);
    if (report !== undefined) {
      expect(renderSummary(report)).toContain("Analysis did not finish.");
      expect(renderSummary(report)).toContain(`Head: \`${HEAD}\``);
    }
  });

  it("marks a missing provider key without clearing the new blocks", async () => {
    const publisher = recordingPublisher();
    const result = await reanalyzePullRequest({
      env: { ...env, LLM_PROVIDER: "claude" },
      client: billingClient(),
      publisher,
    });

    expect(result).toMatchObject({
      outcome: "published",
      headSha: HEAD,
      analysisStatus: "unavailable",
    });
    expect(publisher.reports[0]?.blocks.length).toBeGreaterThan(0);
  });

  it("keeps a prior summary when the pull request cannot be fetched", async () => {
    const prior = `${SUMMARY_MARKER}\n## AI Review Focus\n\n- **capture** in src/billing.ts\n`;
    let stored = prior;
    let patches = 0;
    const publisher = recordingPublisher();
    const fetchImpl: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/issues/4/comments")) {
        return Promise.resolve(
          jsonResponse([{ id: 9, html_url: "https://example.test/c", body: stored }]),
        );
      }
      if (method === "PATCH" && url.includes("/issues/comments/9")) {
        patches += 1;
        const raw = typeof init?.body === "string" ? init.body : "";
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "body" in parsed &&
          typeof parsed.body === "string"
        ) {
          stored = parsed.body;
        }
        return Promise.resolve(
          jsonResponse({ id: 9, html_url: "https://example.test/c", body: stored }),
        );
      }
      return Promise.resolve(jsonResponse({ message: "missing" }, 404));
    };
    const client: GitHubClient = {
      fetchPullRequest: () => Promise.reject(new GitHubRequestError("GitHub request failed.")),
      fetchFileText: () => Promise.reject(new Error("unused")),
      fetchFileContent: () => Promise.reject(new Error("unused")),
    };

    const first = await reanalyzePullRequest({ env, client, publisher, fetch: fetchImpl });
    const second = await reanalyzePullRequest({ env, client, publisher, fetch: fetchImpl });

    expect(first.outcome).toBe("preserved");
    expect(second.outcome).toBe("preserved");
    expect(publisher.reports).toEqual([]);
    expect(stored).toContain(INCOMPLETE_MARKER);
    expect(stored).toContain("**capture**");
    expect(patches).toBe(1);
  });

  it("publishes an empty unavailable report when a failed run has no prior summary", async () => {
    const publisher = recordingPublisher();
    const fetchImpl: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.includes("/issues/4/comments")) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse({ message: "missing" }, 404));
    };
    const result = await reanalyzePullRequest({
      env: { ...env, LLM_PROVIDER: "claude" },
      client: clientFor(
        [
          {
            filename: "dist/app.js",
            status: "modified",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            additions: 1,
            deletions: 1,
          },
        ],
        new Map([
          [`${BASE}:dist/app.js`, text("a\n")],
          [`${HEAD}:dist/app.js`, text("b\n")],
        ]),
      ),
      publisher,
      fetch: fetchImpl,
    });

    expect(result).toMatchObject({ outcome: "published", analysisStatus: "unavailable" });
    expect(publisher.reports[0]?.blocks).toEqual([]);
  });

  it("publishes a complete empty report for an ignored file", async () => {
    const publisher = recordingPublisher();
    const result = await reanalyzePullRequest({
      env,
      client: clientFor(
        [
          {
            filename: "dist/app.js",
            status: "modified",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            additions: 1,
            deletions: 1,
          },
        ],
        new Map([
          [`${BASE}:dist/app.js`, text("a\n")],
          [`${HEAD}:dist/app.js`, text("b\n")],
        ]),
      ),
      publisher,
    });

    expect(result).toMatchObject({
      outcome: "published",
      analysisStatus: "complete",
      headSha: HEAD,
    });
    expect(publisher.reports[0]?.blocks).toEqual([]);
  });

  it("applies the configured language list before parsing", async () => {
    const publisher = recordingPublisher();
    const jsBase = ["export function label(value) {", "  return value.trim();", "}", ""].join("\n");
    const jsHead = [
      "export function label(value) {",
      "  return value.toLowerCase();",
      "}",
      "",
    ].join("\n");
    const patch = [
      "@@ -1,3 +1,3 @@",
      " export function label(value) {",
      "-  return value.trim();",
      "+  return value.toLowerCase();",
      " }",
      "",
    ].join("\n");
    const result = await reanalyzePullRequest({
      env: {
        ...env,
        REVIEW_FOCUS_CONFIG: "tests/fixtures/reanalyze/typescript-only.yml",
      },
      client: clientFor(
        [
          {
            filename: "src/label.js",
            status: "modified",
            patch,
            additions: 1,
            deletions: 1,
          },
        ],
        new Map([
          [`${BASE}:src/label.js`, text(jsBase)],
          [`${HEAD}:src/label.js`, text(jsHead)],
        ]),
      ),
      publisher,
    });

    expect(result.analysisStatus).toBe("partial");
    expect(publisher.reports[0]?.blocks.map((block) => block.name)).toEqual(["src/label.js"]);
  });

  it("names a missing pull request number and does not fetch", async () => {
    const publisher = recordingPublisher();
    await expect(
      reanalyzePullRequest({
        env: { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "acme/demo" },
        client: billingClient(),
        publisher,
      }),
    ).rejects.toThrow("REVIEW_PULL_REQUEST is not set.");
    expect(publisher.reports).toEqual([]);
  });

  it("uses the review repository and app token when both are set", () => {
    expect(
      reanalyzeProcessEnv({
        GITHUB_TOKEN: "job-token",
        GITHUB_REPOSITORY: "tahirhsn91/ai-pr-review-navigator",
        REVIEW_GITHUB_TOKEN: "app-token",
        REVIEW_REPOSITORY: "tahirhsn91/PSX_Scraper",
        REVIEW_PULL_REQUEST: "135",
      }),
    ).toMatchObject({
      GITHUB_TOKEN: "app-token",
      GITHUB_REPOSITORY: "tahirhsn91/PSX_Scraper",
      REVIEW_PULL_REQUEST: "135",
    });
  });
});
