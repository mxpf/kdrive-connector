import { AuthenticationError, ConfigurationError, KDriveApiError } from "./errors.js";

export type OperationalLogEntry = {
  event: string;
  [key: string]: string | number | boolean | undefined;
};

function boundedErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) return undefined;
  return value;
}

export function operationalErrorFields(error: unknown): {
  errorCategory: string;
  httpStatus?: number;
  errorCode?: string;
} {
  if (error instanceof KDriveApiError) {
    const errorCode = boundedErrorCode(error.code);
    return {
      errorCategory: "kdrive_api_error",
      ...(Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599
        ? { httpStatus: error.status }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }
  if (error instanceof AuthenticationError) return { errorCategory: "authentication_error" };
  if (error instanceof ConfigurationError) return { errorCategory: "configuration_error" };
  if (error instanceof Error) return { errorCategory: "application_error" };
  return { errorCategory: "non_error_throw" };
}

export function operationalResult(value: unknown): "success" | "error" | "asynchronous" | "unknown" {
  return value === "success" || value === "error" || value === "asynchronous" ? value : "unknown";
}

export function operationalErrorCode(value: unknown): string | undefined {
  return boundedErrorCode(value);
}

export function logOperationalInfo(entry: OperationalLogEntry): void {
  console.info(entry);
}

export function logOperationalError(entry: OperationalLogEntry): void {
  console.error(entry);
}
