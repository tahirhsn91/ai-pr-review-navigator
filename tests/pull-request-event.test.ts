import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatPullRequestEventReport,
  parsePullRequestEventDocument,
  parsePullRequestEventMetadata,
  PULL_REQUEST_EVENT_ACTIONS,
  PullRequestEventError,
  readPullRequestEventMetadata,
} from "../src/github/pull-request-event.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function event(
  action: (typeof PULL_REQUEST_EVENT_ACTIONS)[number],
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    pull_request: {
      number: 12,
      base: { sha: baseSha, ref: "main" },
      head: { sha: headSha, ref: "feature" },
      title: "Example",
    },
    repository: { full_name: "example/demo" },
    ...extra,
  };
}

describe("parsePullRequestEventMetadata", () => {
  it("accepts each review trigger and ignores unrelated event fields", () => {
    for (const action of PULL_REQUEST_EVENT_ACTIONS) {
      expect(parsePullRequestEventMetadata(event(action))).toEqual({
        eventType: action,
        number: 12,
        baseSha,
        headSha,
      });
    }
  });

  it("normalizes SHA case", () => {
    const metadata = parsePullRequestEventMetadata({
      action: "synchronize",
      pull_request: {
        number: 7,
        base: { sha: baseSha.toUpperCase() },
        head: { sha: headSha.toUpperCase() },
      },
    });
    expect(metadata.baseSha).toBe(baseSha);
    expect(metadata.headSha).toBe(headSha);
  });

  it("formats the log lines", () => {
    expect(
      formatPullRequestEventReport({
        eventType: "ready_for_review",
        number: 12,
        baseSha,
        headSha,
      }),
    ).toBe(
      [
        "Review Focus pull request metadata",
        "event: ready_for_review",
        "number: 12",
        `base: ${baseSha}`,
        `head: ${headSha}`,
      ].join("\n"),
    );
  });

  it("rejects missing and invalid metadata without echoing the value", () => {
    const leaked = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const cases: unknown[] = [
      {},
      { action: "opened" },
      { action: "closed", pull_request: event("opened").pull_request },
      { action: leaked, pull_request: event("opened").pull_request },
      {
        action: "opened",
        pull_request: { number: 0, base: { sha: baseSha }, head: { sha: headSha } },
      },
      {
        action: "opened",
        pull_request: { number: 1.5, base: { sha: baseSha }, head: { sha: headSha } },
      },
      {
        action: "opened",
        pull_request: { number: "12", base: { sha: baseSha }, head: { sha: headSha } },
      },
      {
        action: "opened",
        pull_request: { number: 12, base: { sha: "abc" }, head: { sha: headSha } },
      },
      {
        action: "opened",
        pull_request: { number: 12, base: { sha: leaked }, head: { sha: headSha } },
      },
      { action: "opened", pull_request: { number: 12, head: { sha: headSha } } },
      null,
      [],
    ];

    for (const input of cases) {
      let thrown: unknown;
      try {
        parsePullRequestEventMetadata(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PullRequestEventError);
      if (thrown instanceof PullRequestEventError) {
        expect(thrown.code).toBe("pull_request_event_invalid");
        expect(thrown.message).not.toContain(leaked);
      }
    }
  });
});

describe("pull request event files", () => {
  it("reads a valid event file", () => {
    const directory = mkdtempSync(join(tmpdir(), "review-focus-event-"));
    const eventPath = join(directory, "event.json");
    try {
      writeFileSync(eventPath, JSON.stringify(event("reopened")), "utf8");
      expect(readPullRequestEventMetadata(eventPath)).toMatchObject({
        eventType: "reopened",
        number: 12,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing path, a missing file, invalid JSON, and an oversized document", () => {
    expect(() => readPullRequestEventMetadata(undefined)).toThrow(/GITHUB_EVENT_PATH is missing/);
    expect(() => readPullRequestEventMetadata("   ")).toThrow(/GITHUB_EVENT_PATH is missing/);
    expect(() =>
      readPullRequestEventMetadata(join(tmpdir(), "missing-review-focus-event.json")),
    ).toThrow(/not found/);
    expect(() => parsePullRequestEventDocument("{")).toThrow(/not valid JSON/);
    expect(() => parsePullRequestEventDocument("{}", 1)).toThrow(/exceeds 1 bytes/);
  });
});
