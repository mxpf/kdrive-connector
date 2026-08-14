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
