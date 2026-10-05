import { reanalyzeFailureMessage, reanalyzePullRequest } from "./pipeline.js";

try {
  const result = await reanalyzePullRequest({ env: process.env });
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
