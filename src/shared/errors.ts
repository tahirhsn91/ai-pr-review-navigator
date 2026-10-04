export class ReviewNavigatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigError extends ReviewNavigatorError {
  constructor(message: string) {
    super("config_invalid", message);
  }
}

export class NotImplementedError extends ReviewNavigatorError {
  constructor(feature: string) {
    super("not_implemented", `${feature} is not implemented. Later milestones add this behavior.`);
  }
}
