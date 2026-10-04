import type {
  FileContentResult,
  GitHubClient,
  PullRequestFile,
  PullRequestRef,
} from "../github/types.js";
import { isSafeRepoPath } from "../github/client.js";
import { isGeneratedPath } from "./indicators.js";
import { parsePullRequestFile } from "./parser.js";
import { assertPullRequestDiff } from "./schema.js";
import type { FileSource, ProcessedFileChange, PullRequestDiff } from "./types.js";

export async function processPullRequestDiff(input: {
  readonly client: GitHubClient;
  readonly ref: PullRequestRef;
}): Promise<PullRequestDiff> {
  const snapshot = await input.client.fetchPullRequest(input.ref);
  const files: ProcessedFileChange[] = [];
  for (const file of snapshot.files) {
    files.push(
      await processFile(input.client, input.ref, file, snapshot.baseSha, snapshot.headSha),
    );
  }
  return assertPullRequestDiff({
    ref: input.ref,
    title: snapshot.title,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    files,
    complete: files.every((file) => file.lineMappingComplete && file.contentComplete),
  });
}

async function processFile(
  client: GitHubClient,
  ref: PullRequestRef,
  file: PullRequestFile,
  baseSha: string,
  headSha: string,
): Promise<ProcessedFileChange> {
  const parsed = parsePullRequestFile(file);
  const plan = sourcePlan(file);
  const base = await loadSource(client, ref, plan.base, baseSha, "not_in_base");
  const head = await loadSource(client, ref, plan.head, headSha, "not_in_head");
  const pathRefused =
    !isSafeRepoPath(file.filename) ||
    (file.previousFilename !== undefined && !isSafeRepoPath(file.previousFilename));
  const rename =
    file.status === "renamed" && file.previousFilename !== undefined
      ? { from: file.previousFilename, to: file.filename }
      : undefined;
  const deletion = file.status === "removed" ? { path: file.filename } : undefined;
  const indicators = {
    binary: parsed.patchStatus === "binary" || base.status === "binary" || head.status === "binary",
    generated:
      isGeneratedPath(file.filename) ||
      (file.previousFilename !== undefined && isGeneratedPath(file.previousFilename)),
    oversized: base.status === "oversized" || head.status === "oversized",
    unsupported:
      pathRefused ||
      parsed.patchStatus === "invalid" ||
      (file.status === "renamed" && file.previousFilename === undefined) ||
      base.status === "unsupported" ||
      head.status === "unsupported",
  };
  const contentComplete =
    sideComplete(base) &&
    sideComplete(head) &&
    !(file.status === "renamed" && file.previousFilename === undefined);

  return {
    ...parsed,
    baseSha,
    headSha,
    base,
    head,
    indicators,
    contentComplete,
    ...(rename === undefined ? {} : { rename }),
    ...(deletion === undefined ? {} : { deletion }),
  };
}

interface FetchSide {
  readonly kind: "fetch";
  readonly path: string;
}

interface AbsentSide {
  readonly kind: "absent";
}

function sourcePlan(file: PullRequestFile): {
  readonly base: FetchSide | AbsentSide;
  readonly head: FetchSide | AbsentSide;
} {
  if (file.status === "added") {
    return { base: { kind: "absent" }, head: { kind: "fetch", path: file.filename } };
  }
  if (file.status === "removed") {
    return { base: { kind: "fetch", path: file.filename }, head: { kind: "absent" } };
  }
  if (file.status === "renamed") {
    if (file.previousFilename === undefined) {
      return { base: { kind: "absent" }, head: { kind: "fetch", path: file.filename } };
    }
    return {
      base: { kind: "fetch", path: file.previousFilename },
      head: { kind: "fetch", path: file.filename },
    };
  }
  const basePath = file.previousFilename ?? file.filename;
  return {
    base: { kind: "fetch", path: basePath },
    head: { kind: "fetch", path: file.filename },
  };
}

async function loadSource(
  client: GitHubClient,
  ref: PullRequestRef,
  side: FetchSide | AbsentSide,
  sha: string,
  absentReason: "not_in_base" | "not_in_head",
): Promise<FileSource> {
  if (side.kind === "absent") {
    return { status: "absent", reason: absentReason };
  }
  if (!isSafeRepoPath(side.path)) {
    return { status: "unsupported", reason: "unsafe path" };
  }
  const content = await client.fetchFileContent({
    owner: ref.owner,
    repo: ref.repo,
    path: side.path,
    sha,
  });
  return mapContent(content);
}

function mapContent(content: FileContentResult): FileSource {
  if (content.status === "absent") {
    return { status: "absent", reason: "not_found" };
  }
  return content;
}

function sideComplete(source: FileSource): boolean {
  if (source.status === "absent") {
    return source.reason !== "not_found";
  }
  return (
    source.status === "present" || source.status === "binary" || source.status === "unsupported"
  );
}
