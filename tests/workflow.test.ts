import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { PULL_REQUEST_EVENT_ACTIONS } from "../src/github/pull-request-event.js";

const workflowSchema = z
  .object({
    name: z.string(),
    on: z
      .object({
        pull_request: z
          .object({
            types: z.array(z.enum(PULL_REQUEST_EVENT_ACTIONS)),
          })
          .strict(),
      })
      .strict(),
    permissions: z
      .object({
        contents: z.literal("read"),
        "pull-requests": z.literal("read"),
      })
      .strict(),
    concurrency: z
      .object({
        group: z.string(),
        "cancel-in-progress": z.literal(true),
      })
      .strict(),
    defaults: z
      .object({
        run: z
          .object({
            shell: z.string(),
          })
          .strict(),
      })
      .strict(),
    jobs: z.record(
      z
        .object({
          "runs-on": z.string(),
          "timeout-minutes": z.number().int().positive(),
          steps: z.array(
            z
              .object({
                name: z.string(),
                uses: z.string().optional(),
                run: z.string().optional(),
                with: z.record(z.unknown()).optional(),
                env: z.record(z.string()).optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

describe("pr-review-focus workflow", () => {
  it("triggers on the review events and stays read-only", () => {
    const text = readFileSync(resolve(".github/workflows/pr-review-focus.yml"), "utf8");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/secrets\./u);
    expect(text).not.toMatch(/:\s*write\b/u);
    expect(text).not.toMatch(/ANTHROPIC|OPENAI|LLM_/u);

    const workflow = workflowSchema.parse(parse(text));
    expect(workflow.on.pull_request.types).toEqual([...PULL_REQUEST_EVENT_ACTIONS]);
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.defaults.run.shell).toContain("pipefail");

    const jobs = Object.values(workflow.jobs);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job).toBeDefined();
    if (job === undefined) {
      return;
    }
    expect(job["timeout-minutes"]).toBe(15);

    const uses = job.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    expect(uses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]);

    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });

    const setupNode = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setupNode?.with).toMatchObject({ "node-version": "24", cache: "npm" });

    const commands = job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
    expect(commands).toEqual([
      "npm ci",
      "npm run type-check",
      "npm run lint",
      "npm test",
      "npm run build",
      "node dist/github/report-pull-request-event.js",
    ]);

    for (const step of job.steps) {
      if (step.run === undefined) {
        continue;
      }
      expect(step.env).toMatchObject({ GITHUB_TOKEN: "", GH_TOKEN: "" });
    }
  });
});
