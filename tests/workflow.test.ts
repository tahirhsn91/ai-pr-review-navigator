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

describe("publish review focus workflow", () => {
  it("grants write only to the trusted dispatch job", () => {
    const text = readFileSync(resolve(".github/workflows/publish-review-focus.yml"), "utf8");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/ANTHROPIC|OPENAI|LLM_/u);
    expect(text).not.toContain("APPROVE");

    const workflow = publishWorkflowSchema.parse(parse(text));
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });

    const job = workflow.jobs.publish;
    expect(job).toBeDefined();
    if (job === undefined) {
      return;
    }
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.ref }}",
    });
    expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");

    const install = job.steps.find((step) => step.run === "npm ci");
    const build = job.steps.find((step) => step.run === "npm run build");
    expect(install?.env).toMatchObject({ GITHUB_TOKEN: "", GH_TOKEN: "" });
    expect(build?.env).toMatchObject({ GITHUB_TOKEN: "", GH_TOKEN: "" });

    const publish = job.steps.find(
      (step) => step.run === "node dist/publisher/publish-review-focus.js",
    );
    expect(publish?.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      GH_TOKEN: "",
      REVIEW_FOCUS_REPORT: "${{ inputs.report_path }}",
    });
  });
});

describe("reanalyze review focus workflow", () => {
  it("analyzes from the trusted checkout and keeps secrets off the install steps", () => {
    const text = readFileSync(resolve(".github/workflows/reanalyze-review-focus.yml"), "utf8");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toContain("github.event.workflow_run.head_sha");
    expect(text).not.toContain("github.event.pull_request.head");
    expect(text).not.toContain("APPROVE");
    expect(text).toContain('workflows: ["PR Review Focus"]');
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("cancel-in-progress: false");
    expect(text).toContain("conclusion != 'cancelled'");
    expect(text).toContain("ref: ${{ github.ref }}");
    expect(text).toContain("persist-credentials: false");
    expect(text).toContain("node dist/reanalyze-pull-request.js");
    expect(text.split("github.token")).toHaveLength(2);

    const workflow = reanalyzeWorkflowSchema.parse(parse(text));
    expect(workflow.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
    const job = workflow.jobs.reanalyze;
    expect(job?.["timeout-minutes"]).toBe(15);
    const checkout = job?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.ref }}",
    });
    const install = job?.steps.find((step) => step.run === "npm ci");
    const build = job?.steps.find((step) => step.run === "npm run build");
    expect(install?.env).toEqual({ GITHUB_TOKEN: "", GH_TOKEN: "" });
    expect(build?.env).toEqual({ GITHUB_TOKEN: "", GH_TOKEN: "" });
    const analyze = job?.steps.find((step) => step.run === "node dist/reanalyze-pull-request.js");
    expect(analyze?.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      GH_TOKEN: "",
      LLM_PROVIDER: "${{ vars.LLM_PROVIDER || 'none' }}",
      ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}",
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
    });
  });
});

const reanalyzeWorkflowSchema = z
  .object({
    on: z
      .object({
        workflow_run: z.object({}).passthrough(),
        workflow_dispatch: z.object({}).passthrough(),
      })
      .strict(),
    permissions: z
      .object({
        contents: z.literal("read"),
        "pull-requests": z.literal("write"),
      })
      .strict(),
    jobs: z
      .object({
        reanalyze: z
          .object({
            "timeout-minutes": z.number(),
            steps: z.array(
              z
                .object({
                  uses: z.string().optional(),
                  run: z.string().optional(),
                  with: z.record(z.unknown()).optional(),
                  env: z.record(z.string()).optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

describe("review another repository workflow", () => {
  it("uses the app token for the named repository and keeps the key off the install steps", () => {
    const text = readFileSync(resolve(".github/workflows/review-another-repository.yml"), "utf8");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toContain("github.token");
    expect(text).not.toContain("APPROVE");
    expect(text).toContain("name: Review another repository");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("cancel-in-progress: false");
    expect(text).toContain("ref: ${{ github.ref }}");
    expect(text).toContain("persist-credentials: false");
    expect(text).toContain(
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    );
    expect(text).toContain("permission-metadata: read");
    expect(text).toContain("permission-contents: read");
    expect(text).toContain("permission-issues: write");
    expect(text).toContain("permission-pull-requests: write");

    const workflow = reviewAnotherRepositorySchema.parse(parse(text));
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs.review;
    expect(job?.["timeout-minutes"]).toBe(15);
    const install = job?.steps.find((step) => step.run === "npm ci");
    const build = job?.steps.find((step) => step.run === "npm run build");
    expect(install?.env).toEqual({ GITHUB_TOKEN: "", GH_TOKEN: "" });
    expect(build?.env).toEqual({ GITHUB_TOKEN: "", GH_TOKEN: "" });
    const token = job?.steps.find((step) => step.id === "app-token");
    expect(token?.with).toMatchObject({
      "app-id": "${{ vars.APP_ID }}",
      "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
      owner: "${{ inputs.owner }}",
      repositories: "${{ inputs.repository }}",
    });
    const review = job?.steps.find((step) => step.run === "node dist/reanalyze-pull-request.js");
    expect(review?.env).toMatchObject({
      REVIEW_GITHUB_TOKEN: "${{ steps.app-token.outputs.token }}",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      REVIEW_REPOSITORY: "${{ inputs.owner }}/${{ inputs.repository }}",
      REVIEW_PULL_REQUEST: "${{ inputs.pull_request }}",
    });
  });
});

const reviewAnotherRepositorySchema = z
  .object({
    name: z.literal("Review another repository"),
    on: z
      .object({
        workflow_dispatch: z.object({}).passthrough(),
      })
      .strict(),
    permissions: z
      .object({
        contents: z.literal("read"),
      })
      .strict(),
    jobs: z
      .object({
        review: z
          .object({
            "timeout-minutes": z.number(),
            steps: z.array(
              z
                .object({
                  id: z.string().optional(),
                  uses: z.string().optional(),
                  run: z.string().optional(),
                  with: z.record(z.unknown()).optional(),
                  env: z.record(z.string()).optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const publishWorkflowSchema = z
  .object({
    on: z
      .object({
        workflow_dispatch: z.object({}).passthrough(),
      })
      .strict(),
    permissions: z
      .object({
        contents: z.literal("read"),
        "pull-requests": z.literal("write"),
      })
      .strict(),
    jobs: z
      .object({
        publish: z
          .object({
            steps: z.array(
              z
                .object({
                  uses: z.string().optional(),
                  run: z.string().optional(),
                  with: z.record(z.unknown()).optional(),
                  env: z.record(z.string()).optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
