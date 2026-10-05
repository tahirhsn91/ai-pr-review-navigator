import { reanalyzeFailureMessage, reanalyzePullRequest } from "./pipeline.js";

const reviewToken = process.env.REVIEW_GITHUB_TOKEN;
const env =
  reviewToken !== undefined && reviewToken.trim().length > 0
    ? { ...process.env, GITHUB_TOKEN: reviewToken }
    : process.env;

try {
  if (reviewToken !== undefined && reviewToken.trim().length > 0) {
    process.stdout.write("Using the review app token.\n");
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
