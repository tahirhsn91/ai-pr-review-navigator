import { z } from "zod";

import { GitHubRequestError } from "../github/errors.js";
import {
  githubRequest,
  readGitHubJson,
  readNextLink,
  type GitHubHttpOptions,
} from "../github/http.js";
import { PublishError } from "./errors.js";

const MAX_COMMENT_PAGES = 20;

const issueCommentSchema = z
  .object({
    id: z.number().int().positive(),
    html_url: z.string().min(1),
    body: z.string(),
  })
  .passthrough();

const reviewCommentSchema = issueCommentSchema
  .extend({
    path: z.string().nullable().optional(),
    line: z.number().int().positive().nullable().optional(),
    side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  })
  .passthrough();

export interface IssueComment {
  readonly id: number;
  readonly url: string;
  readonly body: string;
}

export interface ReviewComment extends IssueComment {
  readonly path: string | null;
  readonly line: number | null;
  readonly side: "LEFT" | "RIGHT" | null;
}

export interface CommentClient {
  listIssueComments(): Promise<readonly IssueComment[]>;
  createIssueComment(body: string): Promise<IssueComment>;
  updateIssueComment(commentId: number, body: string): Promise<IssueComment>;
  deleteIssueComment(commentId: number): Promise<void>;
  listReviewComments(): Promise<readonly ReviewComment[]>;
  createReviewComment(input: {
    readonly body: string;
    readonly commitId: string;
    readonly path: string;
    readonly line: number;
    readonly side: "LEFT" | "RIGHT";
  }): Promise<
    { readonly posted: true; readonly comment: ReviewComment } | { readonly posted: false }
  >;
  updateReviewComment(commentId: number, body: string): Promise<void>;
  deleteReviewComment(commentId: number): Promise<void>;
}

export function createCommentClient(input: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly http: GitHubHttpOptions;
}): CommentClient {
  const root = `${input.http.apiBaseUrl ?? "https://api.github.com"}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  return {
    listIssueComments: () =>
      listPages(`${root}/issues/${input.number}/comments?per_page=100`, input.http, parseIssue),
    createIssueComment: (body) =>
      writeIssue(input.http, `${root}/issues/${input.number}/comments`, "POST", { body }),
    updateIssueComment: (commentId, body) =>
      writeIssue(input.http, `${root}/issues/comments/${commentId}`, "PATCH", { body }),
    deleteIssueComment: (commentId) =>
      removeComment(input.http, `${root}/issues/comments/${commentId}`),
    listReviewComments: () =>
      listPages(`${root}/pulls/${input.number}/comments?per_page=100`, input.http, parseReview),
    createReviewComment: (comment) =>
      createReview(input.http, `${root}/pulls/${input.number}/comments`, comment),
    updateReviewComment: async (commentId, body) => {
      await writeIssue(input.http, `${root}/pulls/comments/${commentId}`, "PATCH", { body });
    },
    deleteReviewComment: (commentId) =>
      removeComment(input.http, `${root}/pulls/comments/${commentId}`),
  };
}

async function listPages<T>(
  firstUrl: string,
  http: GitHubHttpOptions,
  parse: (value: unknown) => T,
): Promise<T[]> {
  const comments: T[] = [];
  let url: string | undefined = firstUrl;
  let pages = 0;
  while (url !== undefined) {
    pages += 1;
    if (pages > MAX_COMMENT_PAGES) {
      throw new PublishError("GitHub comment list exceeded the page limit.");
    }
    const response = await githubRequest(url, http);
    const body = await readGitHubJson(response, http.token);
    if (!Array.isArray(body)) {
      throw new PublishError("GitHub comment list was invalid.");
    }
    for (const entry of body) {
      comments.push(parse(entry));
    }
    url = readNextLink(response.headers.get("link"));
  }
  return comments;
}

async function writeIssue(
  http: GitHubHttpOptions,
  url: string,
  method: "POST" | "PATCH",
  body: { readonly body: string },
): Promise<IssueComment> {
  const response = await githubRequest(url, { ...http, method, body });
  return parseIssue(await readGitHubJson(response, http.token));
}

async function createReview(
  http: GitHubHttpOptions,
  url: string,
  comment: {
    readonly body: string;
    readonly commitId: string;
    readonly path: string;
    readonly line: number;
    readonly side: "LEFT" | "RIGHT";
  },
): Promise<
  { readonly posted: true; readonly comment: ReviewComment } | { readonly posted: false }
> {
  const response = await githubRequest(url, {
    ...http,
    method: "POST",
    body: {
      body: comment.body,
      commit_id: comment.commitId,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      subject_type: "line",
    },
  });
  if (response.status === 422) {
    await response.arrayBuffer();
    return { posted: false };
  }
  return {
    posted: true,
    comment: parseReview(await readGitHubJson(response, http.token)),
  };
}

async function removeComment(http: GitHubHttpOptions, url: string): Promise<void> {
  const response = await githubRequest(url, { ...http, method: "DELETE" });
  if (response.status !== 204 && !response.ok) {
    throw new GitHubRequestError(`GitHub request failed (${response.status}).`);
  }
  await response.arrayBuffer();
}

function parseIssue(value: unknown): IssueComment {
  const parsed = issueCommentSchema.safeParse(value);
  if (!parsed.success) {
    throw new PublishError("GitHub comment response was invalid.");
  }
  return { id: parsed.data.id, url: parsed.data.html_url, body: parsed.data.body };
}

function parseReview(value: unknown): ReviewComment {
  const parsed = reviewCommentSchema.safeParse(value);
  if (!parsed.success) {
    throw new PublishError("GitHub review comment response was invalid.");
  }
  return {
    id: parsed.data.id,
    url: parsed.data.html_url,
    body: parsed.data.body,
    path: parsed.data.path ?? null,
    line: parsed.data.line ?? null,
    side: parsed.data.side ?? null,
  };
}
