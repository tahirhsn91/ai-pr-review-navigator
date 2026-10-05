import { ReviewNavigatorError } from "../shared/errors.js";

export class PublishError extends ReviewNavigatorError {
  constructor(message: string) {
    super("publish_failed", message);
  }
}

export class PublishUnavailableError extends ReviewNavigatorError {
  constructor() {
    super("publish_unavailable", "GitHub publisher is not configured.");
  }
}
