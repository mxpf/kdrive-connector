import { randomUUID } from "node:crypto";
export { classifyBinaryFailure as binaryErrorCode } from "./binary-transport.js";
import { logOperationalInfo, logOperationalError } from "./operational-logging.js";

export type BinaryStage = "resolve" | "source_fetch" | "source_read" | "session_start" | "chunk_upload" | "finalization" | "presentation" | "reference" | "download" | "validate_reference";

export function binaryTrace(operation: string, parentTraceId?: string) {
  const traceId = randomUUID();
  const started = Date.now();
  let stage: BinaryStage = "resolve";
  let bytes = 0;
  let digestCacheHit: boolean | undefined;
  let avoidedDownloadBytes: number | undefined;
  const write = (ok: boolean, event: string, code?: string) => {
    // Only internally generated labels/numbers, never error messages or URLs.
    (ok ? logOperationalInfo : logOperationalError)({ event, operation, traceId, parentTraceId,
      stage, bytes, digestCacheHit, avoidedDownloadBytes, durationMs: Date.now() - started, ok, errorCode: code });
  };
  return {
    traceId,
    get stage() { return stage; },
    digestCache(hit: boolean, avoidedBytes: number) {
      digestCacheHit = hit; avoidedDownloadBytes = avoidedBytes;
      write(true, "kdrive.binary.digest_cache");
    },
    progress(next: BinaryStage, count = bytes) { stage = next; bytes = count; write(true, "kdrive.binary.progress"); },
    complete(ok: boolean, code?: string) { write(ok, "kdrive.binary.completed", code); },
  };
}
