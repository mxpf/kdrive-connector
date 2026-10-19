# Work Mode internal-error investigation — October 19, 2026

Status: **cause confirmed; fix implemented and locally validated; deployment pending CI**.
Cloudflare Free is retained. No folder creation, uploads, original-file
modifications or credential changes were performed during this investigation.

## Report and corroboration

The user reported `kdrive_list_directory` and `kdrive_connection_status`
returning host-level MCP `-32603: Internal error` around 17:13–17:15 EDT
(21:13–21:15 UTC). A current connection-status call reproduced that error.

Cloudflare GraphQL metrics for 21:12–21:16 UTC returned ten failed
`KDriveMCP` invocations, all `scriptThrewException`. These are internal
invocations, not ten independently established user tool calls.

A live Wrangler tail captured the reproduction at **21:17:24.806 UTC**:

```text
POST /mcp -> HTTP 500
SqlError: SQL query failed: Exceeded allowed rows written in Durable Objects free tier.

KDriveMCP.sql
KDriveMCP._ensureSchema
new Agent
new McpAgent
new KDriveMCP
```

The outer exception propagated through `getServerByName` and the OAuth
provider. The deployed version was `f19c3e4e-0da1-4e26-b8e7-e60bd8458a14`.
The failure occurs during Durable Object construction, before tool registration
or a request to the kDrive API. Tool-level error handling cannot catch it.

The historical telemetry API returned 403 with the current CLI token. Therefore
the exact original two request payloads/exceptions were not retrieved; the
reported-window failure metrics and the live reproduction are distinct evidence.
No claim is made that an individual historical request was conclusively matched
by a trace ID supplied by the user.

## Quota and session churn

Namespace metadata confirms the affected namespace belongs to `KDriveMCP`.
Daily metrics at investigation time reported:

| Namespace | Rows written |
| --- | ---: |
| MCP sessions | 183,526 |
| Operation nonces | 37 |
| Binary digest cache | 3 |

The MCP namespace reported 176,351 writes in the 20:00–21:00 UTC hour,
concentrated in the session traffic burst around 20:15–20:50 UTC
(16:15–16:50 EDT). That hour also reported 8,670 HTTP invocations with
`responseStreamDisconnected`, 20,275 successful JS RPC invocations and
8,693 hibernation invocations. A query for the ten highest-write session
objects returned 61 written / 393 read rows for each.

These are Cloudflare analytics measurements, not a separately verified billing
ledger; sampled/aggregated analytics should not be treated as exact allowance
accounting. The explicit runtime quota exception is the authoritative evidence
that the write allowance was exhausted.

Source inspection shows the installed Agents SDK initializes SQL schema in the
Agent constructor, stores session initialization/props, and persists stream
request IDs and response replay events. Read-only kDrive operations can therefore
cause Cloudflare metadata writes without changing any kDrive file.

The concentration across new session objects and stream disconnections strongly
suggests session/reconnection churn. The metrics do not establish which client
or retry/discovery behavior triggered that churn. Do not attribute all traffic
to the two reported calls, OCR, uploads or a particular client without additional
evidence.

## Authentication and recovery

This observed failure is a **storage quota exception**, not an authentication
rejection. It occurs after OAuth routing and before any upstream kDrive request;
it does not independently establish the current validity of the upstream kDrive
API credential. Reauthentication is not a remedy for the demonstrated failure.

An intentionally unauthenticated `GET /mcp` separately returned HTTP 401,
`invalid_token`, and `WWW-Authenticate` with resource metadata. Do not relabel
the quota exception as an authentication error.

Cloudflare documents **100,000 written rows per day** on Free, with daily limits
resetting at **00:00 UTC**. For this incident, the next reset is **October 19 at
20:00 EDT** (October 20 at 00:00 UTC). The old transport cannot recover until the limit resets; the replacement
removes its session SQL dependency. Continuing session churn could otherwise
exhaust the next allowance again.
No upgrade, namespace recreation, authentication bypass or repeated live tool
retry loop was used as a workaround.

Sources: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Implemented fix — capability revision 2026-10-19.3

- Replaced the Agents MCP/WebSocket/replay bridge with the standard MCP SDK's
  JSON Streamable HTTP transport in the existing Durable Object class. No new
  namespace, migration, paid service or plan setting is introduced. The unused
  Agents dependency and 76 transitive packages are removed without upgrading
  remaining dependency versions.
- Session setup/discovery uses no SQL/KV tables, alarms or persisted replay
  events. HMAC-signed session IDs bind the authorized owner and expire in 12
  hours. All authenticated GET streams return 405, including resumption GETs.
- Old, terminated or evicted sessions return 404. Clients may initialize once
  and retry reads; file changes are never replayed automatically. A per-isolate
  30-initialization/minute guard returns 429 and Retry-After. This reduces burst
  amplification but is not a global rate limiter or proof of the original
  client's trigger. Production traffic measurements remain a separate gate.
- Specific Free row-read/write exhaustion is caught outside DO initialization
  and in ordinary/binary tool handlers. Results include
  `CLOUDFLARE_QUOTA_EXCEEDED`, trace ID, UTC reset and retry interval, and
  `requires_reauthentication: false`. Initialization uses HTTP 503; tools use
  MCP `isError`. Unknown transport exceptions are redacted. OAuth 401
  challenges and the separate durable confirmation nonce store are preserved.
- Background OCR remains in session memory with the existing bounded
  `waitUntil` lifetime. A lost session never silently restarts inference.

## Local validation

- 221 root tests passed (two concurrent test files).
- 31 Worker tests passed (two workers), including 12 independent SDK sessions
  with three catalog reads each: one initialization per client and zero
  session KV entries, user SQL tables or alarms. Session termination,
  eviction/expiry/tampering, owner binding, admission control, body limits,
  OAuth boundary and quota/error redaction are covered.
- All five workerd HTTP scenarios passed: signed-byte delivery, direct PDF
  extraction, rendering, existing OCR deadline/recovery, and the new production
  session transport. The new test completes a synthetic OCR inference delayed
  46 seconds across separate real HTTP requests, rejects a second session's
  polling attempt, verifies one download/inference, and inspects zero session
  storage records. No external service or AI call is used by these tests.
- Both independent HTTP/Python PDF integration tests passed (ordinary and
  password-protected), along with both TypeScript checks, the root build and
  Wrangler deployment dry run.
- Initial broad parallel runs hit local CPU/startup deadlines; bounded reruns
  passed. The first independent PDF run lacked its Python test dependency;
  installing the pinned requirements into a temporary venv resolved it. The
  new HTTP harness also required explicit bundler package-entry resolution;
  its corrected test passed. These were not production test failures.

The full diff was reviewed for authentication, session isolation, mutation
replay, quota handling and secret-safe diagnostics. The production bindings,
Free plan, upload policy and original kDrive files are unchanged.

## Release and post-reset verification

Code commit, CI run and deployed version will be recorded after their actual
completion. The currently deployed pre-fix version is
`f19c3e4e-0da1-4e26-b8e7-e60bd8458a14`; rolling back cannot restore quota.

A one-time follow-up is scheduled for **October 19, 20:05 EDT** (00:05 UTC
October 20), after the 00:00 UTC quota reset. It will verify
`kdrive_connection_status` and `kdrive_list_directory` for `/Private` with
limit 100, record only sanitized status/count/build information, and inspect
session write metrics. No folder creation, uploads or original-file changes
are part of that check. Post-reset acceptance is pending until it actually runs.
