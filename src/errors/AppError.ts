export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: string | undefined;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: string,
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

export class InvalidRequestError extends AppError {
  constructor(
    message: string = "Invalid request parameters",
    details?: string
  ) {
    super(message, "INVALID_REQUEST", 400, details);
  }
}

export class CaseGenerationError extends AppError {
  constructor(message: string = "Case generation failed", details?: string) {
    super(message, "GENERATION_FAILED", 500, details);
  }
}
