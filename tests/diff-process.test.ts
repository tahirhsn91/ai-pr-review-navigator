import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "../src/diff/parse-patch.js";
import { processPullRequestDiff } from "../src/diff/process.js";
import { pullRequestDiffSchema } from "../src/diff/schema.js";
import type {
  FileContentResult,
  GitHubClient,
  PullRequestFile,
  PullRequestSnapshot,
} from "../src/github/types.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const ref = { owner: "acme", repo: "demo", number: 4 };

function readPatch(name: string): string {
  return readFileSync(resolve("tests/fixtures/diffs", name), "utf8");
}

interface RecordedCall {
  readonly path: string;
  readonly sha: string;
}

function clientFor(
  files: readonly PullRequestFile[],
  contents: ReadonlyMap<string, FileContentResult>,
): GitHubClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetchPullRequest(): Promise<PullRequestSnapshot> {
      return Promise.resolve({ ref, title: "Example", baseSha, headSha, files });
    },
    fetchFileText(): Promise<string> {
      return Promise.reject(new Error("fetchFileText is not used by the diff processor"));
    },
    fetchFileContent(request): Promise<FileContentResult> {
      calls.push({ path: request.path, sha: request.sha });
      const content = contents.get(`${request.sha}:${request.path}`);
      if (content === undefined) {
        return Promise.reject(new Error(`missing content for ${request.sha}:${request.path}`));
      }
      return Promise.resolve(content);
    },
  };
}

function text(value: string): FileContentResult {
  return { status: "present", text: value, byteLength: Buffer.byteLength(value) };
}

describe("pull request diff fixtures", () => {
  it("maps a modified file without mixing base and head source", async () => {
    const client = clientFor(
      [
        {
          filename: "src/widget.ts",
          status: "modified",
          patch: readPatch("modified.patch"),
          additions: 1,
          deletions: 1,
        },
      ],
      new Map([
        [`${baseSha}:src/widget.ts`, text("BASE_SOURCE")],
        [`${headSha}:src/widget.ts`, text("HEAD_SOURCE")],
      ]),
    );

    const diff = await processPullRequestDiff({ client, ref });
    expect(pullRequestDiffSchema.parse(diff)).toMatchObject({ complete: true, baseSha, headSha });
    const file = diff.files[0];
    expect(file).toMatchObject({
      path: "src/widget.ts",
      status: "modified",
      patchStatus: "parsed",
      lineMappingComplete: true,
      contentComplete: true,
      baseSha,
      headSha,
      addedRanges: [{ startLine: 2, endLine: 2 }],
      removedRanges: [{ startLine: 2, endLine: 2 }],
      base: { status: "present", text: "BASE_SOURCE" },
      head: { status: "present", text: "HEAD_SOURCE" },
    });
    expect(file?.hunks[0]?.lines.map((line) => line.type)).toEqual([
      "context",
      "delete",
      "add",
      "context",
      "context",
    ]);
    expect(client.calls).toEqual([
      { path: "src/widget.ts", sha: baseSha },
      { path: "src/widget.ts", sha: headSha },
    ]);
  });

  it("maps an added file and does not fetch base content", async () => {
    const client = clientFor(
      [
        {
          filename: "src/new.ts",
          status: "added",
          patch: readPatch("added.patch"),
          additions: 2,
          deletions: 0,
        },
      ],
      new Map([[`${headSha}:src/new.ts`, text("alpha\nbeta\n")]]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.files[0]).toMatchObject({
      patchStatus: "parsed",
      lineMappingComplete: true,
      addedRanges: [{ startLine: 1, endLine: 2 }],
      removedRanges: [],
      base: { status: "absent", reason: "not_in_base" },
      head: { status: "present", text: "alpha\nbeta\n" },
    });
    expect(client.calls).toEqual([{ path: "src/new.ts", sha: headSha }]);
  });

  it("maps a deleted file and records the deletion", async () => {
    const client = clientFor(
      [
        {
          filename: "src/old.ts",
          status: "removed",
          patch: readPatch("deleted.patch"),
          additions: 0,
          deletions: 2,
        },
      ],
      new Map([[`${baseSha}:src/old.ts`, text("alpha\nbeta\n")]]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.files[0]).toMatchObject({
      lineMappingComplete: true,
      addedRanges: [],
      removedRanges: [{ startLine: 1, endLine: 2 }],
      deletion: { path: "src/old.ts" },
      base: { status: "present", text: "alpha\nbeta\n" },
      head: { status: "absent", reason: "not_in_head" },
    });
    expect(client.calls).toEqual([{ path: "src/old.ts", sha: baseSha }]);
  });

  it("loads a rename from the previous path at the base SHA", async () => {
    const client = clientFor(
      [
        {
          filename: "src/new.ts",
          previousFilename: "src/old.ts",
          status: "renamed",
          patch: readPatch("renamed.patch"),
          additions: 1,
          deletions: 1,
        },
      ],
      new Map([
        [`${baseSha}:src/old.ts`, text("OLD_FILE")],
        [`${headSha}:src/new.ts`, text("NEW_FILE")],
      ]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.complete).toBe(true);
    expect(diff.files[0]).toMatchObject({
      rename: { from: "src/old.ts", to: "src/new.ts" },
      base: { status: "present", text: "OLD_FILE" },
      head: { status: "present", text: "NEW_FILE" },
      addedRanges: [{ startLine: 2, endLine: 2 }],
      removedRanges: [{ startLine: 2, endLine: 2 }],
    });
    expect(client.calls).toEqual([
      { path: "src/old.ts", sha: baseSha },
      { path: "src/new.ts", sha: headSha },
    ]);
  });

  it("keeps test-only edits and their line numbers", async () => {
    const client = clientFor(
      [
        {
          filename: "tests/widget.test.ts",
          status: "modified",
          patch: readPatch("test-only.patch"),
          additions: 1,
          deletions: 1,
        },
      ],
      new Map([
        [`${baseSha}:tests/widget.test.ts`, text("base test")],
        [`${headSha}:tests/widget.test.ts`, text("head test")],
      ]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.complete).toBe(true);
    expect(diff.files[0]).toMatchObject({
      path: "tests/widget.test.ts",
      addedRanges: [{ startLine: 11, endLine: 11 }],
      removedRanges: [{ startLine: 11, endLine: 11 }],
      indicators: { generated: false, binary: false, oversized: false, unsupported: false },
    });
  });

  it("marks a missing patch incomplete instead of reporting no changes", async () => {
    const missing = JSON.parse(
      readFileSync(resolve("tests/fixtures/diffs/missing.json"), "utf8"),
    ) as {
      filename: string;
      status: "modified";
      additions: number;
      deletions: number;
    };
    const client = clientFor(
      [missing],
      new Map([
        [`${baseSha}:src/gap.ts`, text("base")],
        [`${headSha}:src/gap.ts`, text("head")],
      ]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.complete).toBe(false);
    expect(diff.files[0]).toMatchObject({
      patchStatus: "missing",
      lineMappingComplete: false,
      hunks: [],
      addedRanges: [],
      removedRanges: [],
      base: { text: "base" },
      head: { text: "head" },
    });
  });

  it("maps every hunk of a large patch", async () => {
    const patch = readPatch("large.patch");
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.patchStatus).toBe("parsed");
    if (parsed.patchStatus !== "parsed") {
      return;
    }
    expect(parsed.hunks).toHaveLength(40);
    expect(parsed.addedCount).toBe(40);
    parsed.hunks.forEach((hunk, index) => {
      const start = index * 10 + 1;
      expect(hunk.oldStart).toBe(start);
      expect(hunk.newStart).toBe(start);
      expect(hunk.lines.find((line) => line.type === "add")?.newLineNumber).toBe(start + 1);
      expect(hunk.lines.find((line) => line.type === "delete")?.oldLineNumber).toBe(start + 1);
    });

    const client = clientFor(
      [{ filename: "src/large.ts", status: "modified", patch, additions: 40, deletions: 40 }],
      new Map([
        [`${baseSha}:src/large.ts`, text("base")],
        [`${headSha}:src/large.ts`, text("head")],
      ]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.files[0]?.lineMappingComplete).toBe(true);
    expect(diff.files[0]?.addedRanges).toHaveLength(40);
  });

  it("marks binary and oversized files without storing their bytes as text", async () => {
    const binaryClient = clientFor(
      [{ filename: "assets/logo.png", status: "modified", patch: readPatch("binary.patch") }],
      new Map<string, FileContentResult>([
        [`${baseSha}:assets/logo.png`, { status: "binary", byteLength: 4 }],
        [`${headSha}:assets/logo.png`, { status: "binary", byteLength: 4 }],
      ]),
    );
    const binary = await processPullRequestDiff({ client: binaryClient, ref });
    expect(binary.complete).toBe(false);
    expect(binary.files[0]).toMatchObject({
      patchStatus: "binary",
      lineMappingComplete: false,
      indicators: { binary: true },
      base: { status: "binary" },
      head: { status: "binary" },
    });
    expect(JSON.stringify(binary.files[0])).not.toContain("PNG_BYTES");

    const oversizedClient = clientFor(
      [
        {
          filename: "src/huge.ts",
          status: "modified",
          patch: readPatch("modified.patch"),
          additions: 1,
          deletions: 1,
        },
      ],
      new Map<string, FileContentResult>([
        [`${baseSha}:src/huge.ts`, text("base")],
        [`${headSha}:src/huge.ts`, { status: "oversized", byteLength: 1_000_001 }],
      ]),
    );
    const oversized = await processPullRequestDiff({ client: oversizedClient, ref });
    expect(oversized.complete).toBe(false);
    expect(oversized.files[0]).toMatchObject({
      lineMappingComplete: true,
      contentComplete: false,
      indicators: { oversized: true },
      head: { status: "oversized", byteLength: 1_000_001 },
    });
    expect(JSON.stringify(oversized.files[0]?.head)).not.toContain("text");
  });

  it("flags a generated path and still maps its changed lines", async () => {
    const client = clientFor(
      [
        {
          filename: "dist/app.min.js",
          status: "modified",
          patch: readPatch("modified.patch"),
          additions: 1,
          deletions: 1,
        },
      ],
      new Map([
        [`${baseSha}:dist/app.min.js`, text("base")],
        [`${headSha}:dist/app.min.js`, text("head")],
      ]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.files[0]).toMatchObject({
      indicators: { generated: true },
      lineMappingComplete: true,
      addedRanges: [{ startLine: 2, endLine: 2 }],
    });
  });

  it("marks an unexpected missing head file", async () => {
    const client = clientFor(
      [
        {
          filename: "src/widget.ts",
          status: "modified",
          patch: readPatch("modified.patch"),
          additions: 1,
          deletions: 1,
        },
      ],
      new Map<string, FileContentResult>([
        [`${baseSha}:src/widget.ts`, text("base")],
        [`${headSha}:src/widget.ts`, { status: "absent" }],
      ]),
    );
    const diff = await processPullRequestDiff({ client, ref });
    expect(diff.complete).toBe(false);
    expect(diff.files[0]?.head).toEqual({ status: "absent", reason: "not_found" });
    expect(diff.files[0]?.base).toMatchObject({ status: "present", text: "base" });
  });
});

describe("unified diff details", () => {
  it("ignores the no-newline marker", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new"].join("\n"),
    );
    expect(parsed.patchStatus).toBe("parsed");
    if (parsed.patchStatus === "parsed") {
      expect(parsed.removedRanges).toEqual([{ startLine: 1, endLine: 1 }]);
      expect(parsed.addedRanges).toEqual([{ startLine: 1, endLine: 1 }]);
    }
  });

  it("rejects a patch whose hunk header does not match its lines", () => {
    expect(parseUnifiedDiff("@@ -1,2 +1,2 @@\n-only\n").patchStatus).toBe("invalid");
  });
});
