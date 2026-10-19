/** Recognize only the platform's specific quota signal, never generic 401/403/SQL errors. */
export function quotaErrorDetails(error: unknown, traceId: string = crypto.randomUUID(), now = Date.now()) {
  if (!(error instanceof Error) || !/Exceeded allowed rows (?:written|read) in Durable Objects free tier\./.test(error.message)) return undefined;
  const reset = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  return {
    error_code: "CLOUDFLARE_QUOTA_EXCEEDED", connector_error_code: "CLOUDFLARE_QUOTA_EXCEEDED",
    message: `Cloudflare Free storage quota is exhausted. Retry after ${new Date(reset).toISOString()}. Reconnecting will not restore quota. Do not automatically repeat file-changing operations; check their outcome first.`,
    requires_reauthentication: false, retry_at: new Date(reset).toISOString(),
    retry_after_seconds: Math.ceil((reset - now) / 1000), trace_id: traceId,
  };
}
export function quotaErrorContent(error: unknown, traceId?: string) {
  const result = quotaErrorDetails(error, traceId);
  return result ? { isError: true, structuredContent: result,
    content: [{ type: "text" as const, text: JSON.stringify(result) }] } : undefined;
}
