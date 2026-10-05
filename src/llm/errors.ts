import { ReviewNavigatorError } from "../shared/errors.js";

export class LlmRequestError extends ReviewNavigatorError {
  constructor(message: string) {
    super("llm_request_failed", message);
  }
}

export class LlmLimitError extends ReviewNavigatorError {
  constructor(message: string) {
    super("llm_limit_exceeded", message);
  }
}
