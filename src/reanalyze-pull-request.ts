import { reanalyzeFailureMessage, reanalyzeProcessEnv, reanalyzePullRequest } from "./pipeline.js";

const env = reanalyzeProcessEnv(process.env);

try {
  if (process.env.REVIEW_GITHUB_TOKEN?.trim()) {
    process.stdout.write("Using the review app token.\n");
  }
  const repository = env.GITHUB_REPOSITORY;
  const pullRequest = env.REVIEW_PULL_REQUEST;
  if (repository !== undefined && pullRequest !== undefined) {
    process.stdout.write(`Reviewing ${repository}#${pullRequest}.\n`);
  }
  const result = await reanalyzePullRequest({ env });
  const lines = [`Review focus ${result.outcome}.`];
  if (result.baseSha !== undefined) {
    lines.push(`Base: ${result.baseSha}`);
  }
  if (result.headSha !== undefined) {
    lines.push(`Head: ${result.headSha}`);
  }
  if (result.analysisStatus !== undefined) {
    lines.push(`Status: ${result.analysisStatus}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  process.stderr.write(`${reanalyzeFailureMessage(error)}\n`);
  process.exitCode = 1;
}
