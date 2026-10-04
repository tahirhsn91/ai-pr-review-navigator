import { ReviewNavigatorError } from "../shared/errors.js";

export class GitHubRequestError extends ReviewNavigatorError {
  constructor(message: string) {
    super("github_request_failed", message);
  }
}

export function redactSecret(message: string, secret: string): string {
  const redacted = secret.length > 0 ? message.split(secret).join("[redacted]") : message;
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}
