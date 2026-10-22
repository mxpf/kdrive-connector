# RPC disconnect follow-up — October 19, 2026

Status: **deployed and read-only smoke checks passed**. Cloudflare Free is unchanged.
Production is `4d0cb91f-8ad2-4d34-93e5-601af407a224`, capability
`2026-10-19.4`, deployed from commit `ed9eb25` on October 19 at approximately
22:20 UTC (18:20 EDT). No kDrive uploads or file changes were performed.

## What the eight events mean

The earlier 21:42–21:52 UTC GraphQL window reported eight DO RPC
`clientDisconnected` outcomes, four RPC successes, zero session rows read or
written, and 35 successful Worker invocations with zero Worker errors. Those
are aggregate counts, not eight identified failed user tool calls. Historical
per-request logs were not retrieved with the available observability access.

A bounded live tail at approximately 22:07–22:08 UTC reproduced the pattern
without a deployment. This investigation made one read-only connection-status
call. Its result reached the caller successfully on production revision `.3`.
The corresponding sanitized trace showed:

- `connection_status` tool completed successfully in 898 ms.
- Outer `POST /mcp` returned HTTP 200 with outcome `ok`.
- Internal `handleMcpRequest` RPC ended with outcome `canceled`, no exception.
- Initialization also paired HTTP 200 with a canceled RPC; the empty HTTP 202
  notification paired with a successful RPC.
- Other concurrent read traffic visible in the tail similarly completed with
  `ok: true` and HTTP 200 before the internal RPC was labeled canceled. No file
  content, names, headers, credentials or raw request bodies were retained.

This is evidence of internal RPC lifetime/cleanup accounting after successful
HTTP delivery, not evidence that those reproduced reads failed. It does not
prove the outcome of each of the original eight aggregate events.

The previous `.3` bridge passed `Request` and `Response` objects through RPC. Their
bodies use transferable stream capabilities. Cloudflare documents that an RPC
with capabilities may outlive its method return, and a Worker caller is
considered disconnected when its execution context ends. See
[RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).
That is the supported explanation for the observed successful-response/canceled-
RPC pairing. Ordinary local workerd tail tests report `ok` for both old and new
bridges, so elimination of the production metric remains an edge verification
gate, not a locally proven claim. The post-deployment observations below now
provide a bounded edge check.

## Confirmed SDK session defects

The pinned MCP SDK 1.29.0 retains a JSON response resolver after each successful
request. A separate baseline reproduction completed three requests and observed
three retained `_streamMapping` entries. Closing the SDK transport during a
pending request left its HTTP promise unresolved. These behaviors match
[upstream issue 2559](https://github.com/modelcontextprotocol/typescript-sdk/issues/2559).
The installed root SDK 1.30.0 also contains the missing JSON cleanup; upgrading
that package alone would not fix this path.

## Released changes

- The Worker/DO boundary now passes bounded byte arrays, status and protocol
  headers. It finishes reading the JSON response inside the DO before returning
  values; no Request, Response, stream, AbortSignal, bearer token, cookie or
  external URL is passed across that boundary. This removes the stream
  capability lifetime from the MCP RPC result. Binary download endpoints retain
  their separate streaming path.
- A small `JsonMcpTransport` adapter cleans only the completed request's mapping,
  leaving concurrent requests active. Closing a session settles pending HTTP
  requests with 409 and `CONNECTOR_SESSION_CLOSED`, explicitly warning that a
  mutation's outcome may be unknown. Late handler results cannot recreate
  mappings, and no operation is replayed.
- The cleanup workaround uses the pinned SDK's private maps in one isolated
  module, with a constructor shape check and regression tests. Revisit/remove
  it when the upstream fix lands; this is a maintenance constraint.
- Inspection also found the deployed 4 MiB request cap blocked valid 10 MiB
  base64 inline uploads. The JSON request cap is now 16 MiB, and actual body
  bytes are checked even without Content-Length. MCP JSON responses are bounded
  at 16 MiB too; both sit below Cloudflare's
  [32 MiB serialized RPC ceiling](https://developers.cloudflare.com/workers/runtime-apis/rpc/#limitations).
  Oversized JSON uploads receive guidance to use a binary reference. Existing
  per-tool decoded file limits remain unchanged. A failed response handoff
  never automatically retries the underlying operation.
- OAuth, signed owner-bound sessions, expiration, burst control, quota errors,
  no session SQL/KV writes, confirmation nonces and OCR job lifetimes remain.

## Validation

- 35 Worker tests passed, including 100 completed JSON requests with zero
  retained response entries; concurrent pending/finished responses; DELETE
  during a pending request; no mutation replay or late-result resurrection;
  byte limits; and a synthetic 10 MiB base64 payload admitted at the RPC
  boundary without forwarding bearer/cookie headers. No real upload occurred.
- A real workerd HTTP test passes the production bridge and SDK client through
  initialization, JSON tool requests, an OCR job with 46-second delayed mock
  inference, cross-session rejection, polling and session deletion. It checks
  one download/inference, zero SQL/KV records, no outbound service calls and
  successful local RPC tail outcomes.
- Both TypeScript checks and the root build passed. Targeted root diagnostics
  and quota tests also passed.

## Deployment and live verification

The user authorized commit, push, CI verification, deployment and read-only
production checks. Commit `ed9eb25` passed both Linux and macOS jobs in
[CI run 39333806765](https://github.com/mxpf/kdrive-connector/actions/runs/39333806765)
before deployment. The Wrangler dry run passed, followed by a successful normal
deployment with the existing Free-compatible bindings and configuration.

At approximately 22:21 UTC, the connected ChatGPT tools returned:

- Connection status: `connected: true`, build
  `4d0cb91f-8ad2-4d34-93e5-601af407a224`, capability `2026-10-19.4`.
- Directory browsing: `/Private`, limit 100, 13 items, no continuation page.
- Transport diagnostics: JSON, memory-only sessions, no response replay.

A 90-second sanitized live tail beginning 22:21:20 UTC captured 25 events,
all on the new build. All nine `handleMcpRequest` RPC events ended `ok`, with
**zero canceled/disconnected RPCs and zero exceptions**. The two requested
tool completions were successful (connection status 302 ms; directory listing
865 ms). Unlike the previous `.3` trace, successful HTTP JSON responses were
paired with successful internal RPC outcomes. The tail also contains client
initialization/protocol traffic with HTTP 400/405; these had no runtime
exceptions and did not prevent either requested tool from succeeding. We did
not retain request bodies to diagnose each protocol probe.

A read-only GraphQL query filtered to 22:21–22:23 UTC returned a nonempty but
smaller aggregate sample: one successful DO RPC, zero DO errors/disconnects,
five Worker invocations, zero Worker errors/client disconnects, and zero MCP
namespace rows read/written. Both invocation datasets identify the new build.
These counters are subject to ingestion delay and sampling; they do not replace
the nine directly observed RPC outcomes or represent a billing reconciliation.
The measured zero-write namespace result is separate from the connector's
static `session_sql_writes: 0` diagnostic. This short window confirms the
observed symptom is resolved for these checks, not a guarantee of zero future
disconnects under all traffic.

The quota reset is still at 00:00 UTC October 20 (20:00 EDT October 19).
The existing 20:05 EDT post-reset verification should now expect this `.4`
production version. This deployment check is pre-reset, not post-reset
acceptance. No authentication, plan or kDrive file changes were made.

## Post-reset verification — October 20, 00:10–00:11 UTC

The scheduled check ran after the 00:00 UTC reset (October 19, 20:00 EDT).
The clock was verified at 00:10:17 UTC; the read-only checks completed at
approximately 20:10 EDT. Production remained build
`4d0cb91f-8ad2-4d34-93e5-601af407a224`, capability `2026-10-19.4`.
Both release CI run `39333806765` and evidence CI run `39334598304` were
completed successfully. Git was clean before recording this check.

| Check | Observed result |
| --- | --- |
| Connection status (one call) | Connected, expected build/revision |
| Directory browsing (one call, limit 100) | 13 items, no continuation page |
| Session transport diagnostic | JSON, memory-only, replay disabled |
| MCP namespace rows written / read | 0 / 0 |
| DO RPC invocations | 48 successful, 0 errors, 0 clientDisconnected |
| Worker invocations | 91 successful, 0 errors, 0 client disconnects |

The GraphQL filter window was October 20, 00:00–00:10 UTC. Returned telemetry
contained a nonempty 00:05 five-minute bucket, and both invocation datasets
identified the expected production build. Storage counts are independently
measured namespace telemetry, not just the static transport diagnostic.
Analytics ingestion and sampling still apply; these are observed counts in
that window, not proof of every request or a quota billing reconciliation.

A separate bounded 60-second sanitized live tail around the two requested
checks captured 18 events, including six successful `handleMcpRequest` RPCs,
zero canceled/disconnected RPCs and zero exceptions. Event timestamps were
00:10:35–00:10:45 UTC, all on the expected build. Connection status completed
in 383 ms; directory browsing completed in 588 ms. This live trace is separate
from the earlier aggregate window; the counts should not be combined.

All four requested health checks passed in the observed post-reset windows.
There were no blockers. No deployment, configuration/plan changes, uploads,
OCR inference or kDrive file mutations were performed. Cloudflare Free is
unchanged. Only this local sanitized evidence record was updated.

## Next-day follow-up — October 20, 20:05–20:06 EDT

UTC time was verified at October 21, 00:05:25, after the 00:00 UTC reset.
The earlier October 20, 20:05 UTC scheduler trigger was four hours early;
no health checks ran then. This was the corrected one-time check.
Production remained `4d0cb91f-8ad2-4d34-93e5-601af407a224`, capability
`2026-10-19.4`. The latest repository commit was `6353fa0`; the working tree
was clean before recording this evidence.

One connection-status call succeeded on the expected build. One directory
listing with limit 100 succeeded with 11 items and no continuation page.
The prior count was 13; this read-only check made no file changes and does
not attribute the count change to a connector defect. Transport diagnostics
remain JSON, memory-only, with response replay disabled.

| Observed metric | Since previous check | After latest reset |
| --- | ---: | ---: |
| Session namespace rows written / read | 0 / 0 | Not yet available |
| DO RPC successes | 165 | 5 |
| DO RPC errors / clientDisconnected | 0 / 0 | 0 / 0 |
| Worker invocations | 343 | 10 |
| Worker errors / client disconnects | 0 / 0 | 0 / 0 |

The since-check GraphQL window was October 20, 00:11 UTC through October 21,
00:05 UTC. The fresh post-reset window was October 21, 00:00–00:06:37 UTC.
All returned invocation groups identified the expected production build.
The first 00:00–00:05 query returned no records in any dataset; the later
bounded query returned invocation counts but still no periodic storage records.
An empty storage dataset is unavailable evidence, not a measured zero. The
static `session_sql_writes: 0` diagnostic does not replace that measurement.
Sampling and ingestion delay apply to all aggregate counts, and the overlapping
windows must not be added together.

A separate 60-second sanitized live tail captured 17 events, including six
successful internal RPCs, zero canceled/disconnected RPCs and zero exceptions,
all on the expected build. Event timestamps were 00:05:44–00:05:57 UTC.
Connection status completed in 360 ms and directory browsing in 772 ms.
These direct observations confirm successful post-reset reads and RPC outcomes.

No recurrence of session-write churn or RPC disconnects was observed in the
available telemetry. The only verification limitation is that a separate fresh
post-reset storage counter was not yet available. No further polling was done.
Cloudflare Free is unchanged. No deployment, connector configuration changes,
uploads or kDrive file mutations occurred. Only this sanitized local record
was updated; no ongoing monitoring was created.
