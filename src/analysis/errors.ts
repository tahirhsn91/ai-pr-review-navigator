import { ReviewNavigatorError } from "../shared/errors.js";

export class AnalysisError extends ReviewNavigatorError {
  constructor(message: string) {
    super("analysis_invalid", message);
  }
}

export class LlmUnavailableError extends ReviewNavigatorError {
  constructor() {
    super("llm_unavailable", "LLM provider is not configured.");
  }
}
