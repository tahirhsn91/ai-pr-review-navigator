import { unimplemented } from "../shared/unimplemented.js";
import {
  parseFileContents,
  mapPullRequestFile,
  pullRequestFilesResponseSchema,
  pullRequestResponseSchema,
} from "./contents.js";
import { GitHubRequestError, redactSecret } from "./errors.js";
import {
  FILES_PER_PAGE,
  GITHUB_API_BASE_URL,
  githubRequest,
  MAX_PULL_REQUEST_FILE_PAGES,
  readGitHubJson,
  readNextLink,
  type GitHubHttpOptions,
} from "./http.js";
import type {
  FileContentResult,
  FileTextRequest,
  GitHubClient,
  PullRequestFile,
  PullRequestRef,
  PullRequestSnapshot,
} from "./types.js";

export const MAX_FILE_BYTES = 1_000_000;

export interface GitHubClientOptions extends GitHubHttpOptions {
  readonly maxPages?: number;
  readonly maxFileBytes?: number;
}

export function createUnimplementedGitHubClient(): GitHubClient {
  return {
    fetchPullRequest: unimplemented("GitHubClient.fetchPullRequest"),
    fetchFileText: unimplemented("GitHubClient.fetchFileText"),
    fetchFileContent: unimplemented("GitHubClient.fetchFileContent"),
  };
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  if (options.token.trim().length === 0) {
    throw new GitHubRequestError("GitHub token is missing.");
  }
  const apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
  const maxPages = options.maxPages ?? MAX_PULL_REQUEST_FILE_PAGES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;

  return {
    fetchPullRequest: (ref) => fetchPullRequest(ref, options, apiBaseUrl, maxPages),
    fetchFileText: async (request) => {
      const content = await fetchFileContent(request, options, apiBaseUrl, maxFileBytes);
      if (content.status === "present") {
        return content.text;
      }
      throw new GitHubRequestError(`File text is unavailable (${content.status}).`);
    },
    fetchFileContent: (request) => fetchFileContent(request, options, apiBaseUrl, maxFileBytes),
  };
}

async function fetchPullRequest(
  ref: PullRequestRef,
  options: GitHubClientOptions,
  apiBaseUrl: string,
  maxPages: number,
): Promise<PullRequestSnapshot> {
  assertRef(ref);
  const pullUrl = `${apiBaseUrl}/repos/${encodeSegment(ref.owner)}/${encodeSegment(ref.repo)}/pulls/${ref.number}`;
  const pullResponse = await githubRequest(pullUrl, options);
  const pullBody = pullRequestResponseSchema.safeParse(
    await readGitHubJson(pullResponse, options.token),
  );
  if (!pullBody.success) {
    throw new GitHubRequestError("GitHub pull request response was invalid.");
  }

  const files = await listPullRequestFiles(pullUrl, options, maxPages);
  return {
    ref,
    title: pullBody.data.title,
    baseSha: pullBody.data.base.sha.toLowerCase(),
    headSha: pullBody.data.head.sha.toLowerCase(),
    files,
  };
}

async function listPullRequestFiles(
  pullUrl: string,
  options: GitHubClientOptions,
  maxPages: number,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let nextUrl: string | undefined = `${pullUrl}/files?per_page=${FILES_PER_PAGE}&page=1`;
  let pages = 0;
  while (nextUrl !== undefined) {
    pages += 1;
    if (pages > maxPages) {
      throw new GitHubRequestError("Pull request file list is incomplete.");
    }
    const response = await githubRequest(nextUrl, options);
    const body = pullRequestFilesResponseSchema.safeParse(
      await readGitHubJson(response, options.token),
    );
    if (!body.success) {
      throw new GitHubRequestError("GitHub pull request files response was invalid.");
    }
    files.push(...body.data.map(mapPullRequestFile));
    const link = readNextLink(response.headers.get("link"));
    if (link !== undefined && pages >= maxPages) {
      throw new GitHubRequestError("Pull request file list is incomplete.");
    }
    nextUrl = link;
  }
  return files;
}

async function fetchFileContent(
  request: FileTextRequest,
  options: GitHubClientOptions,
  apiBaseUrl: string,
  maxFileBytes: number,
): Promise<FileContentResult> {
  assertFileRequest(request);
  const url = `${apiBaseUrl}/repos/${encodeSegment(request.owner)}/${encodeSegment(request.repo)}/contents/${encodeRepoPath(request.path)}?ref=${encodeURIComponent(request.sha)}`;
  const response = await githubRequest(url, options);
  if (response.status === 404) {
    await response.arrayBuffer();
    return { status: "absent" };
  }
  if (response.status === 403) {
    const text = await response.text();
    const message = githubMessage(text);
    if (message.toLowerCase().includes("too large")) {
      return { status: "oversized", byteLength: maxFileBytes + 1 };
    }
    throw new GitHubRequestError(
      redactSecret(`GitHub request failed (403). ${message}`, options.token),
    );
  }
  const body = await readGitHubJson(response, options.token);
  return parseFileContents(body, maxFileBytes);
}

function assertRef(ref: PullRequestRef): void {
  if (
    !isRepoName(ref.owner) ||
    !isRepoName(ref.repo) ||
    !Number.isInteger(ref.number) ||
    ref.number < 1
  ) {
    throw new GitHubRequestError("Pull request reference was invalid.");
  }
}

function assertFileRequest(request: FileTextRequest): void {
  if (
    !isRepoName(request.owner) ||
    !isRepoName(request.repo) ||
    !/^[0-9a-f]{40}$/iu.test(request.sha)
  ) {
    throw new GitHubRequestError("File request was invalid.");
  }
  if (!isSafeRepoPath(request.path)) {
    throw new GitHubRequestError("File path was refused.");
  }
}

function isRepoName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/u.test(value);
}

export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    return "GitHub rejected the file request.";
  }
  return "GitHub rejected the file request.";
}
