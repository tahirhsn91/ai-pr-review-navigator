import { describe, expect, it } from "vitest";

import { createGitHubClient, GitHubRequestError, parseFileContents } from "../src/github/index.js";

type FetchInput = Parameters<typeof fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function mockFetch(handler: (input: FetchInput, init?: RequestInit) => Response): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

const token = ["test", "token", "value"].join("-");
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const api = "https://api.github.com";

function pullResponse(status = 200): Response {
  return new Response(
    JSON.stringify({
      title: "Example",
      base: { sha: "A".repeat(40) },
      head: { sha: "B".repeat(40) },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("GitHub pull request retrieval", () => {
  it("follows file pagination and keeps the commit SHAs", async () => {
    const urls: string[] = [];
    const client = createGitHubClient({
      token,
      fetch: mockFetch((input, init) => {
        const url = requestUrl(input);
        urls.push(url);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        const page = new URL(url).searchParams.get("page");
        if (url.endsWith("/pulls/7")) {
          return pullResponse();
        }
        if (page === "1") {
          return new Response(
            JSON.stringify([
              {
                filename: "src/a.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-a\n+b",
              },
            ]),
            {
              status: 200,
              headers: {
                link: `<${api}/repos/acme/demo/pulls/7/files?per_page=100&page=2>; rel="next"`,
              },
            },
          );
        }
        if (page === "2") {
          return new Response(
            JSON.stringify([
              { filename: "src/b.ts", status: "removed", additions: 0, deletions: 2 },
            ]),
            {
              status: 200,
            },
          );
        }
        throw new Error(`unexpected url ${url}`);
      }),
    });

    const snapshot = await client.fetchPullRequest({ owner: "acme", repo: "demo", number: 7 });
    expect(snapshot.baseSha).toBe(baseSha);
    expect(snapshot.headSha).toBe(headSha);
    expect(snapshot.files.map((file) => file.filename)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(urls.some((url) => new URL(url).searchParams.get("page") === "2")).toBe(true);
  });

  it("fails when another file page remains", async () => {
    const client = createGitHubClient({
      token,
      maxPages: 1,
      fetch: mockFetch((input) => {
        const url = requestUrl(input);
        if (url.endsWith("/pulls/7")) {
          return pullResponse();
        }
        return new Response(JSON.stringify([{ filename: "src/a.ts", status: "modified" }]), {
          status: 200,
          headers: { link: `<${api}/repos/acme/demo/pulls/7/files?page=2>; rel="next"` },
        });
      }),
    });

    await expect(
      client.fetchPullRequest({ owner: "acme", repo: "demo", number: 7 }),
    ).rejects.toThrow(/file list is incomplete/);
  });

  it("retries a rate limit and a transient failure", async () => {
    const waits: number[] = [];
    let pullCalls = 0;
    let fileCalls = 0;
    const client = createGitHubClient({
      token,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      fetch: mockFetch((input) => {
        const url = requestUrl(input);
        if (url.endsWith("/pulls/7")) {
          pullCalls += 1;
          if (pullCalls === 1) {
            return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
          }
          return pullResponse();
        }
        fileCalls += 1;
        if (fileCalls === 1) {
          return new Response("{}", { status: 503 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    });

    const snapshot = await client.fetchPullRequest({ owner: "acme", repo: "demo", number: 7 });
    expect(snapshot.files).toEqual([]);
    expect(waits).toEqual([0, 250]);
  });

  it("refuses a redirect away from the API host and keeps the token out of errors", async () => {
    const urls: string[] = [];
    const client = createGitHubClient({
      token,
      fetch: mockFetch((input) => {
        urls.push(requestUrl(input));
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        });
      }),
    });

    await expect(
      client.fetchPullRequest({ owner: "acme", repo: "demo", number: 7 }),
    ).rejects.toBeInstanceOf(GitHubRequestError);
    expect(urls).toEqual([`${api}/repos/acme/demo/pulls/7`]);

    const leaking = createGitHubClient({
      token,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ message: `bad ${token}` }), { status: 401 })),
    });
    await expect(
      leaking.fetchPullRequest({ owner: "acme", repo: "demo", number: 7 }),
    ).rejects.toThrow(GitHubRequestError);
    try {
      await leaking.fetchPullRequest({ owner: "acme", repo: "demo", number: 7 });
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubRequestError);
      if (error instanceof GitHubRequestError) {
        expect(error.message).not.toContain(token);
      }
    }
  });
});

describe("file content at a commit SHA", () => {
  it("requests the exact SHA and returns text", async () => {
    const client = createGitHubClient({
      token,
      fetch: mockFetch((input) => {
        const url = requestUrl(input);
        expect(url).toBe(`${api}/repos/acme/demo/contents/src/app.ts?ref=${headSha}`);
        return new Response(
          JSON.stringify({
            type: "file",
            encoding: "base64",
            size: 5,
            content: Buffer.from("hello").toString("base64"),
          }),
          { status: 200 },
        );
      }),
    });

    await expect(
      client.fetchFileContent({ owner: "acme", repo: "demo", path: "src/app.ts", sha: headSha }),
    ).resolves.toEqual({ status: "present", text: "hello", byteLength: 5 });
  });

  it("marks absent, oversized, binary, and mismatched bodies explicitly", async () => {
    const absent = createGitHubClient({
      token,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })),
    });
    await expect(
      absent.fetchFileContent({ owner: "acme", repo: "demo", path: "src/gone.ts", sha: baseSha }),
    ).resolves.toEqual({ status: "absent" });

    const oversized = parseFileContents(
      {
        type: "file",
        size: 1_000_001,
        encoding: "base64",
        content: Buffer.from("SECRET_BODY").toString("base64"),
      },
      1_000_000,
    );
    expect(oversized).toEqual({ status: "oversized", byteLength: 1_000_001 });
    expect(JSON.stringify(oversized)).not.toContain("SECRET_BODY");

    expect(() =>
      parseFileContents(
        {
          type: "file",
          size: 5,
          encoding: "base64",
          content: Buffer.from("hi").toString("base64"),
        },
        1_000_000,
      ),
    ).toThrow(/size did not match/);

    const binary = parseFileContents(
      {
        type: "file",
        size: 2,
        encoding: "base64",
        content: Buffer.from([0, 1]).toString("base64"),
      },
      1_000_000,
    );
    expect(binary).toEqual({ status: "binary", byteLength: 2 });

    const tooLarge = createGitHubClient({
      token,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              message: "This API returns blobs up to 1 MB. The blob is too large.",
            }),
            {
              status: 403,
            },
          ),
        ),
    });
    await expect(
      tooLarge.fetchFileContent({ owner: "acme", repo: "demo", path: "big.ts", sha: headSha }),
    ).resolves.toMatchObject({ status: "oversized" });
  });
});
