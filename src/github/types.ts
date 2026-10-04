export const PULL_REQUEST_FILE_STATUSES = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;

export type PullRequestFileStatus = (typeof PULL_REQUEST_FILE_STATUSES)[number];

export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface PullRequestFile {
  readonly filename: string;
  readonly status: PullRequestFileStatus;
  readonly patch?: string;
  readonly previousFilename?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface PullRequestSnapshot {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly PullRequestFile[];
}

export interface FileTextRequest {
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
  readonly sha: string;
}

export type FileContentResult =
  | { readonly status: "present"; readonly text: string; readonly byteLength: number }
  | { readonly status: "absent" }
  | { readonly status: "binary"; readonly byteLength: number }
  | { readonly status: "oversized"; readonly byteLength: number }
  | { readonly status: "unsupported"; readonly reason: string };

export interface GitHubClient {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequestSnapshot>;
  fetchFileText(request: FileTextRequest): Promise<string>;
  fetchFileContent(request: FileTextRequest): Promise<FileContentResult>;
}
