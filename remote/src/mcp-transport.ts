/**
 * This connector has no out-of-band notifications or subscriptions. Decline
 * idle standalone SSE streams, which can starve discovery on some HTTP paths.
 * Keep GET resumptions and every POST/DELETE on the original MCP transport.
 * Install inside OAuthProvider.apiHandler so authentication is still required.
 */
export function withoutStandaloneNotifications<TEnv>(handler: {
  fetch(request: Request, env: TEnv, ctx: ExecutionContext): Promise<Response>;
}) {
  return {
    async fetch(request: Request, env: TEnv, ctx: ExecutionContext): Promise<Response> {
      if (new URL(request.url).pathname === "/mcp" && request.method === "GET"
        && !request.headers.get("last-event-id")) {
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST, DELETE", "Cache-Control": "no-store" },
        });
      }
      return handler.fetch(request, env, ctx);
    },
  };
}
