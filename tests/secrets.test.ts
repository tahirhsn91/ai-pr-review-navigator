import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = resolve(".");

const tokenPatterns = [
  /ghp_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /sk-ant-[A-Za-z0-9_-]{10,}/u,
  /sk-proj-[A-Za-z0-9_-]{10,}/u,
];

const skippedDirectories = new Set([".git", "node_modules", "dist", "coverage"]);

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (skippedDirectories.has(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    files.push(path);
  }
  return files;
}

describe("secrets", () => {
  it("keeps .env untracked and .env.example empty of credentials", () => {
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);

    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    const values = example
      .split(/\r?\n/u)
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => line.slice(line.indexOf("=") + 1));
    expect(values).toEqual(["", "none", "", "", "", ".github/review-focus.yml"]);
  });

  it("does not store live token strings in the repository", () => {
    const hits: string[] = [];
    for (const filePath of walk(repoRoot)) {
      if (filePath.endsWith("package-lock.json")) {
        continue;
      }
      const text = readFileSync(filePath, "utf8");
      for (const pattern of tokenPatterns) {
        if (pattern.test(text)) {
          hits.push(filePath);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("tooling", () => {
  it("defines the required scripts and supported runtime", () => {
    const packageJsonSchema = z
      .object({
        scripts: z
          .object({
            build: z.string().min(1),
            lint: z.string().min(1),
            "type-check": z.string().min(1),
            test: z.string().min(1),
          })
          .passthrough(),
        engines: z
          .object({
            node: z.string().min(1),
            npm: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough();
    const packageJson = packageJsonSchema.parse(
      JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")),
    );
    expect(packageJson.engines.node).toContain("20.19.0");
    expect(packageJson.engines.npm).toContain("10.8.0");

    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("20.19.0");
    expect(readme).toContain("10.8.0");
    expect(readme).toMatch(/^1\. \*\*Foundation and contracts\*\* — Current\./m);
    expect(readme).toMatch(/^2\. \*\*GitHub pull request intake\*\* — Current\./m);
    expect(readme).toMatch(/^3\. \*\*Diff model\*\* — Current\./m);
    expect(readme).toMatch(/^4\. \*\*Logical blocks\*\* — Current\./m);
    expect(readme).toMatch(/^5\. \*\*Attention analysis\*\* — Current\./m);
    expect(readme).toMatch(/^6\. \*\*Prioritization\*\* — Current\./m);
    expect(readme).toMatch(/^8\. \*\*Publication\*\* — Current\./m);
    expect(readme).toMatch(/^9\. \*\*GitHub Action\*\* — Current\./m);
    for (const number of [7]) {
      expect(readme).toMatch(new RegExp(`^${number}\\. .+ — Not started\\.`, "m"));
    }
  });
});
