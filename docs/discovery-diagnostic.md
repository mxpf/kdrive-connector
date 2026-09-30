# Live discovery diagnostic — September 29, 2026

The deployed binary-transport build advertises all 17 tools. A successful
authenticated SDK request returned `kdrive_export_file`,
`kdrive_upload_file_ref`, and `kdrive_upload_from_url`. This is stronger evidence
than source registration or a deployment success message alone.

## Reproducer

Run from the repository root with an existing, explicitly authorized Inspector
OAuth grant:

```sh
node scripts/diagnose-discovery.mjs /absolute/path/to/inspector/storage/oauth.json
```

The probe is opt-in and uses only the fixed production kDrive MCP endpoint.
It reads the existing access token in memory, never refreshes it, and never
prints token values, session IDs, headers, raw responses, or error messages.
It sends initialization, discovery, and protocol notifications only; it never
calls tools or changes kDrive files. It creates fresh MCP sessions and closes
the client connections afterward. It does not modify the Inspector grant.

Four runs alternate two conditions:

- `no-get`: the test client locally returns HTTP 405 for the optional standalone
  GET notification stream, without sending that GET to the server. POST streams
  and authentication remain unchanged.
- `delayed`: normal GET notification stream, followed by a one-second pause
  before concurrent discovery requests.

The probe expects 17 tools including all three binary actions, two resources,
and zero resource templates. Any timeout, failed request, or catalog mismatch
returns exit status 1. It is a live regression probe, not an offline unit test.

## Observed results

| Condition | Run 1 | Run 2 |
| --- | --- | --- |
| Optional GET suppressed in client | All three requests passed, 334 ms | All three passed, 237 ms |
| Optional GET enabled, one-second delay | All three timed out at 8 seconds | All three timed out at 8 seconds |

Earlier normal-stream attempts also succeeded on some runs. Both ordinary and
wrapped fetch implementations failed in repeated comparisons, so a fetch
wrapper is not a demonstrated fix. Sequential requests also timed out on a
normal-stream session; concurrency alone does not explain the failure.

## Interpretation and limits

This isolates a reproducible association with the optional standalone GET
stream in this environment. It does not yet identify a faulty line or prove
whether the SDK, network/proxy path, or deployed McpAgent stream/session handling
is responsible. It also does not prove why ChatGPT still advertises 14 tools.
The Inspector timeout cannot be explained solely by ChatGPT metadata caching.

Next: reproduce the same matrix in an isolated Worker transport test, inspect
request/response routing without recording credentials, and verify any narrow
transport change against both notification and POST response delivery. A 405
control in the test client is not a production fix. Do not change authentication
or redeploy merely to refresh metadata.

## Narrow mitigation

The local Worker integration test passes both with and without the mitigation;
it does not reproduce the edge/network timeout. Further live tests with explicit
HTTP connection pools also passed, including a subsequent default-pool run.
Consequently the exact underlying fault is still not proven.

`remote/src/mcp-transport.ts` declines idle standalone `GET /mcp` streams with
HTTP 405. The connector does not use out-of-band notifications/subscriptions.
The wrapper sits **inside** the existing OAuth handler: unauthenticated requests
still receive 401. POST response streams, DELETE session termination, and GET
resumptions carrying `Last-Event-ID` remain delegated to the original transport.
This is a bounded workaround for the isolated trigger, not a claim that the
Cloudflare SDK's internal cause has been fixed. Future subscriptions or dynamic
catalog notifications would require revisiting this choice.

Regression tests cover discovery under both policies, all 17 tools and both
resources, passthrough of POST/DELETE/resumption, and the OAuth boundary.
No authentication mutation or kDrive write was performed. Binary transfer
acceptance and ChatGPT catalog refresh remain separate gates.

## Deployed verification

Worker version `e8d5ab39-4d0b-4484-9d19-85abf6f47d2f` contains the mitigation.
The probe's `--verify` option runs four fresh normal-client sessions without
suppressing GET in the client. All four passed after deployment: 262, 279,
255, and 249 ms for concurrent discovery, returning 17 tools, two resources,
and zero templates each time. An unauthenticated `/mcp` request still returned
401. All 54 root tests and eight Worker tests passed, as did both type checks
and the deployment dry run. This verifies the mitigation on the direct SDK
client, not yet on the user's Inspector UI or ChatGPT's registered catalog.
