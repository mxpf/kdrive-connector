export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class KDriveApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status = 500, code?: string, details?: unknown) {
    super(message);
    this.name = "KDriveApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationError";
  }
}
