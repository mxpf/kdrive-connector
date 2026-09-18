import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildAuthorizationUrl, exchangeAuthorizationCode } from "../src/oauth.js";
import { internalServerErrorResponse, redirectToGithub } from "../remote/src/utils.js";

test("authorization URL includes state, scope, and registered redirect", () => {
  const config = loadConfig({
    INFOMANIAK_CLIENT_ID: "client-123",
    INFOMANIAK_CLIENT_SECRET: "secret",
    INFOMANIAK_REDIRECT_URI: "http://127.0.0.1:53682/callback",
    INFOMANIAK_OAUTH_SCOPE: "drive",
  });
  const url = new URL(buildAuthorizationUrl(config, "state-abc"));
  assert.equal(url.origin + url.pathname, "https://login.infomaniak.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("scope"), "drive");
  assert.equal(url.searchParams.get("state"), "state-abc");
});

test("authorization code exchange uses a form body and stores refresh metadata", async () => {
  const config = loadConfig({
    INFOMANIAK_CLIENT_ID: "client-123",
    INFOMANIAK_CLIENT_SECRET: "secret",
    INFOMANIAK_REDIRECT_URI: "http://127.0.0.1:53682/callback",
  });
  let requestBody = "";
  const fakeFetch: typeof fetch = async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const token = await exchangeAuthorizationCode(config, "auth-code", fakeFetch);
  const form = new URLSearchParams(requestBody);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_secret"), "secret");
  assert.equal(token.refresh_token, "refresh");
  assert.equal(token.client_id, "client-123");
  assert.ok(token.expires_at && token.expires_at > Date.now());
});

test("GitHub authorization redirects preserve both OAuth cookies", () => {
  const headers = new Headers();
  headers.append("Set-Cookie", "approved=one; Path=/; Secure; HttpOnly");
  headers.append("Set-Cookie", "session=two; Path=/; Secure; HttpOnly");

  const response = redirectToGithub(
    new Request("https://connector.example.test/authorize"),
    "state-token",
    "github-client",
    headers,
  );
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = responseHeaders.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];

  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /github\.com\/login\/oauth\/authorize/);
  assert.match(cookies.join("\n"), /approved=one/);
  assert.match(cookies.join("\n"), /session=two/);
});

test("unexpected OAuth failures do not expose exception messages", async () => {
  const response = internalServerErrorResponse();
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Internal server error");
  assert.doesNotMatch(await internalServerErrorResponse().text(), /secret|stack|message/i);
});
