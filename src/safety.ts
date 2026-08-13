import { timingSafeEqual } from "node:crypto";
import { ConfirmationError } from "./errors.js";

export type SensitiveAction = "rename" | "move" | "overwrite" | "trash";

export interface PreparedChange {
  action: SensitiveAction;
  confirmation: string;
  explanation: string;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function prepareConfirmation(
  action: SensitiveAction,
  input: { fileId: number; name?: string; destinationDirectoryId?: number; etag?: string },
): PreparedChange {
  switch (action) {
    case "rename": {
      if (!input.name) throw new ConfirmationError("A new name is required to prepare a rename.");
      return {
        action,
        confirmation: `CONFIRM RENAME ${input.fileId} TO ${quote(input.name)}`,
        explanation: `Rename file ${input.fileId} to ${quote(input.name)}.`,
      };
    }
    case "move": {
      if (!input.destinationDirectoryId) throw new ConfirmationError("A destination directory is required to prepare a move.");
      return {
        action,
        confirmation: `CONFIRM MOVE ${input.fileId} TO ${input.destinationDirectoryId}`,
        explanation: `Move file ${input.fileId} into directory ${input.destinationDirectoryId}.`,
      };
    }
    case "overwrite": {
      if (!input.etag) throw new ConfirmationError("The current ETag is required to prepare an overwrite.");
      return {
        action,
        confirmation: `CONFIRM OVERWRITE ${input.fileId} ETAG ${input.etag}`,
        explanation: `Replace the contents of file ${input.fileId}, only if its ETag is still ${input.etag}.`,
      };
    }
    case "trash":
      return {
        action,
        confirmation: `CONFIRM TRASH ${input.fileId}`,
        explanation: `Move file ${input.fileId} to kDrive trash.`,
      };
  }
}

export function requireConfirmation(received: string, expected: string): void {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  const matches = receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
  if (!matches) {
    throw new ConfirmationError(`Confirmation did not match. The user must explicitly provide: ${expected}`);
  }
}

export function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("The name cannot be empty, '.' or '..'.");
  }
  if (Buffer.byteLength(normalized, "utf8") > 255) {
    throw new Error("The name must be 255 UTF-8 bytes or fewer.");
  }
  return normalized;
}
