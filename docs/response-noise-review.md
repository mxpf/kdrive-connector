# kDrive response noise: investigation and review

Implementation date: 2026-09-24. Base commit:
`3430102a4fb2c200604577e274de3529e63d642f`.
Local review branch: `fix/concise-results-and-digests`.
No deployment, remote branch push, publication, or user-file mutation performed.

## Live baseline

Read-only calls were captured in memory; only metrics are recorded here. Private
file contents, signed open URLs, and operation tokens are not test fixtures.
Numbers below are JavaScript string lengths, **not tokenizer counts**.

| Live sample | Structured JSON characters | Text characters | Entire returned JSON characters | Appended open links |
| --- | ---: | ---: | ---: | ---: |
| Keepinghaus manifesto read | 3,864 | 4,420 | 8,500 | 1 |
| Keepinghaus folder, 63 items | 30,850 | 57,827 | 90,745 | 63 |

In both responses, parsing the JSON prefix of the text yielded exactly the
structured result. The remaining text was the clickable-link appendix. The
current manifesto sample contained 3,126 content characters; this was not the
35 KB file from the original incident. That workload is covered synthetically
below. The reported hundred-thousand-token batch was not replayed.

## Cause

`src/kdrive-tools.ts`'s `jsonContent` explicitly used
`JSON.stringify(value, null, 2)` for text alongside `structuredContent: value`,
and recursively collected every open URL for an appended Markdown list.
`remote/src/kdrive-tools.ts` re-exports this shared implementation. The source
therefore directly explains the deployed payload shape: duplication originates
in the MCP server, before the UI. The existing widget reads structured items and
renders at most ten cards. No evidence requires a presentation-layer change.
The tests also exercise actual MCP client/server transport, not only callbacks.

## Small compatible fix

- Keep existing structured result fields, path inputs, pagination, previews, UI
  resources, and base64 attachment behavior.
- Replace full text serialization with operation-specific summaries. Singular
  results have at most one link; listings/search have no automatic link appendix.
- Preserve prepare/write and undo handles only in machine-readable results.
  No token, expiry, or raw version field is repeated in normal success text.
- Add read-only `kdrive_digest_file({ path })`, returning path, SHA-256 digest,
  declared base64url encoding, and byte count. It uses original bytes and existing
  read limits; identity and version are checked before/after the read. Missing
  versions, changed targets, folders, and oversized reads fail without a digest.
- Update shared instructions and README to direct duplicate audits to digests.

A digest was chosen instead of both digest and pairwise compare tools: callers
can compare small digest results locally and reuse each result across many
pairs, minimizing the additional API surface. No mutation logic was changed.

## Reproducible before/after fixtures

`test/kdrive-results.test.ts` reconstructs the previous formatter for comparison.
These are UTF-8 serialized response bytes, with stable short fixture URLs.
The live signed URLs are longer, so the fixture is not a production size forecast.

| Fixture | Previous response bytes | New response bytes | Reduction | Previous text characters | New text characters |
| --- | ---: | ---: | ---: | ---: | ---: |
| 35,000-byte Markdown-like text | 75,749 | 37,054 | 51.1% | 37,087 | 111 |
| 63 directory items | 23,309 | 7,420 | 68.2% | 14,307 | 76 |

Complete content remains available once in structured data. Digest responses
contain no file content, encoded attachment, or resource link.

## Validation

- `npm test`: 38 passed, including seven new response/digest/transport tests.
- `npm run check`: passed.
- `cd remote && npm run type-check`: passed.
- `cd remote && npm test`: 2 passed (Worker nonce-store tests).
- `git diff --check`: passed.

Coverage includes text/base64 results, attachment preservation, directory
pagination and links, search previews, prepare/overwrite text privacy, exact
replacement-content binding, stale versions, replay rejection, raw binary and
empty digests, same-length different contents, missing versions, folders, size
limits, download failures, and target changes during hashing. Existing UI,
mutation, token, authentication, client, and logging tests also pass.

## Boundaries for review

This patch does not make operation handles invisible to the model: existing
write tools require the model to pass opaque handles between calls. It removes
their human-readable duplication without breaking that safety protocol. Hiding
handles from model context entirely needs a separately reviewed protocol change;
moving them to app-only metadata would break current model-driven writes.

Digests avoid byte transfer to the AI host, not download from Infomaniak. The
existing bounded download buffers the file; no unbounded streaming or cache was
introduced. Oversized files remain unsupported. ETags are used only as version
checks, never as content hashes. Sequential digests are observations of file
versions, not a cross-file transaction; recheck if files may have changed.

Clients that previously parsed JSON out of text must use structuredContent.
No legacy duplicate-JSON mode is included because it would preserve the reported
problem. Existing paths and structured schemas are otherwise preserved.

The live connector remains unchanged. After normal project deployment approval,
refresh tool discovery and smoke-test text reads, listings, digest reads, and a
separately authorized overwrite on a disposable test file.
