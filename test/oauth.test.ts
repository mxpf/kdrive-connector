import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildAuthorizationUrl, exchangeAuthorizationCode } from "../src/oauth.js";

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
