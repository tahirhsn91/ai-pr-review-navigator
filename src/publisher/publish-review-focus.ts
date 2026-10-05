import { PublishError } from "./errors.js";
import { publishReviewFocusFromEnv } from "./command.js";

try {
  await publishReviewFocusFromEnv(process.env);
} catch (error) {
  const message = error instanceof PublishError ? error.message : "Unable to publish review focus.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
