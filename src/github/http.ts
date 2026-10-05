import { GitHubRequestError, redactSecret } from "./errors.js";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const MAX_PULL_REQUEST_FILE_PAGES = 30;
export const GITHUB_MAX_RETRIES = 3;
export const GITHUB_MAX_WAIT_MS = 10_000;
export const FILES_PER_PAGE = 100;

export interface GitHubHttpOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxRetries?: number;
  readonly maxWaitMs?: number;
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function githubRequest(url: string, options: GitHubHttpOptions): Promise<Response> {
  const apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? GITHUB_MAX_RETRIES;
  const maxWaitMs = options.maxWaitMs ?? GITHUB_MAX_WAIT_MS;
  assertAllowedUrl(url, apiBaseUrl);

  let attempt = 0;
  let currentUrl = url;
  let redirects = 0;
  while (attempt < maxRetries) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: options.method ?? "GET",
        headers: githubHeaders(options.token, options.body !== undefined),
        body: options.body === undefined ? null : JSON.stringify(options.body),
        redirect: "manual",
      });
    } catch {
      if (attempt >= maxRetries) {
        throw new GitHubRequestError("GitHub request failed.");
      }
      await sleep(250 * attempt);
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      redirects += 1;
      const location = response.headers.get("location");
      if (redirects > 3 || location === null || !sameOrigin(location, apiBaseUrl)) {
        throw new GitHubRequestError("GitHub redirect was refused.");
      }
      currentUrl = new URL(location, apiBaseUrl).toString();
      attempt -= 1;
      continue;
    }

    if (retryable(response) && attempt < maxRetries) {
      const waitMs = retryDelayMs(response, attempt);
      if (waitMs > maxWaitMs) {
        throw new GitHubRequestError("GitHub rate limit retry wait is too long.");
      }
      await response.arrayBuffer();
      await sleep(waitMs);
      continue;
    }

    return response;
  }

  throw new GitHubRequestError("GitHub request failed.");
}

export function readNextLink(header: string | null): string | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="?next"?/u.exec(part);
    const url = match?.[1];
    if (url !== undefined) {
      return url;
    }
  }
  return undefined;
}

export async function readGitHubJson(response: Response, token: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new GitHubRequestError(failureMessage(response.status, text, token));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubRequestError(`GitHub returned a non-JSON response (${response.status}).`);
  }
}

export function assertAllowedUrl(url: string, apiBaseUrl: string): void {
  if (!sameOrigin(url, apiBaseUrl)) {
    throw new GitHubRequestError("GitHub request URL was refused.");
  }
}

function githubHeaders(token: string, hasBody: boolean): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "ai-pr-review-navigator",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (hasBody) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function sameOrigin(url: string, apiBaseUrl: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(apiBaseUrl);
    return target.protocol === base.protocol && target.host === base.host;
  } catch {
    return false;
  }
}

function retryable(response: Response): boolean {
  if (
    response.status === 429 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  ) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.get("retry-after") !== null
  );
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/u.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (
    response.headers.get("x-ratelimit-remaining") === "0" &&
    reset !== null &&
    /^\d+$/u.test(reset)
  ) {
    return Math.max(0, Number(reset) * 1000 - Date.now());
  }
  return 250 * attempt;
}

function failureMessage(status: number, body: string, token: string): string {
  let detail = `GitHub request failed (${status}).`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      detail = `GitHub request failed (${status}). ${parsed.message}`;
    }
  } catch {
    detail = `GitHub request failed (${status}).`;
  }
  return redactSecret(detail, token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
