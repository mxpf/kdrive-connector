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

export class TextPreviewUnavailableError extends Error {
  readonly code = "TEXT_PREVIEW_UNAVAILABLE";
  constructor(readonly nextTool: "kdrive_read_pdf" | "kdrive_export_file" = "kdrive_export_file") {
    super(nextTool === "kdrive_read_pdf"
      ? "kDrive has no usable text preview for this PDF. Call kdrive_read_pdf to extract its text directly within the connector's PDF limits. Scans may require OCR. For binary transport use kdrive_export_file with a supported host adapter."
      : "kDrive has no usable text preview for this file. The original binary may still be available: call kdrive_export_file, verify its complete bytes and SHA-256 with a supported host file bridge, then use a document reader. Password-protected PDFs require the correct password; scanned PDFs may require OCR. A signed URL is not a native file ID.");
    this.name = "TextPreviewUnavailableError";
  }
}
