export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: string | undefined;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: string
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // Restore prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this);
  }
}

export class ModelUnreachableError extends AppError {
  constructor(
    message: string = "Language model service is unreachable",
    details?: string
  ) {
    super(message, "MODEL_UNREACHABLE", 503, details);
  }
}

export class GenerationError extends AppError {
  constructor(message: string = "Generation failed", details?: string) {
    super(message, "GENERATION_FAILED", 500, details);
  }
}

/**
 * Outline judge hit its iteration cap without accepting. Normal mode fails
 * with this; plan mode shows the outline to the reviewer instead.
 */
export class OutlineNotAcceptedError extends AppError {
  constructor(
    message: string = "The case outline did not pass the consistency check",
    details?: string
  ) {
    super(message, "OUTLINE_NOT_ACCEPTED", 500, details);
  }
}
