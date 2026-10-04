import { appendFileSync } from "node:fs";

import {
  formatPullRequestEventReport,
  PullRequestEventError,
  readPullRequestEventMetadata,
} from "./pull-request-event.js";

try {
  const metadata = readPullRequestEventMetadata(process.env.GITHUB_EVENT_PATH);
  const report = `${formatPullRequestEventReport(metadata)}\n`;
  process.stdout.write(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath.length > 0) {
    appendFileSync(summaryPath, report);
  }
} catch (error) {
  const message =
    error instanceof PullRequestEventError
      ? error.message
      : "Unable to read pull request metadata.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
