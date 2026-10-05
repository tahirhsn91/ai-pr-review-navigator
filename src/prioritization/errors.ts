import { ReviewNavigatorError } from "../shared/errors.js";

export class PrioritizationError extends ReviewNavigatorError {
  constructor(message: string) {
    super("prioritization_invalid", message);
  }
}
