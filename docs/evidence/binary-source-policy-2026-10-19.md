# Binary source policy investigation — October 19, 2026

The reported failures occurred before kDrive upload session creation:

| Route | Reported trace | Cause |
| --- | --- | --- |
| Native file adapter | `2c227100-46db-47a7-a9a0-b3d95e967a68` | Observed `sdmntprwestus2.oaiusercontent.com` absent from exact allowlist |
| Direct Archive URL | `d478e2ad-4552-416a-b8e2-c7ee62f552d1` | Archive.org was not an approved binary ingestion source |

Before this investigation, the live connector reported build `9dd6d9ed-d4a2-467f-9c97-89b9261d0e0f`,
capability revision `2026-10-13.7`. OCR-job changes were still local at that point. The later combined release
authorization and deployment supersede that initial state; see the release
record linked below.

## Exact-host correction

The local Node defaults and Worker configuration now include:

- `sdmntprwestus2.oaiusercontent.com`: the user-observed native adapter host;
  public DNS and credential-free HTTPS HEAD succeeded (root status 400 is
  expected for a host without a signed file path, not evidence of file access).
- `sdmntprcacentral.oaiusercontent.com`: selected by this session's real native
  file adapter; independently verified with public DNS and HTTPS HEAD (400).
- `archive.org`: the explicitly requested public source.
- `dn760102.eu.archive.org`: observed HTTPS redirect from the Archive download;
  final response 200 with Content-Length 24,323,083.
- `ia600901.us.archive.org` and `ia800901.us.archive.org`: exact mirrors returned
  by the item's Archive metadata; each independently passed public DNS, TLS and
  HTTP 200/Content-Length checks for the same PDF derivative.

These are exact entries, not regional wildcards or an automatic trust expansion.
Other Archive mirrors and OpenAI regions remain denied until reviewed. This
fix does not claim every one of the 34 acquisition files or download hosts has
been tested. Archive's download routing can change. Bounded numbered Archive
hostnames may be reported in denial messages for review, without paths or queries;
diagnostic visibility never grants permission to fetch them.

No suffix wildcard, private-IP exception, automatic redirect following,
credential forwarding, size-limit increase or integrity bypass was introduced.
Every redirect still passes the same exact-host and public-DNS checks. The
existing redirect count, complete-response checks, streamed size enforcement,
SHA-256-before-finalization and conflict-safe writes remain unchanged.

## Reproduction and error contract

The [Archive item](https://archive.org/details/wxfw_ramanuja-gita-bhashya-with-translation-by-swami-adidevanand-ramakrishna-math)
has both a 287,434,157-byte image PDF and a 24,323,083-byte PDF-with-text
derivative. The latter is the requested reproduction. Fetching it through the
patched source validator, including its redirect, produced exactly:

```text
size_bytes: 24323083
sha256: 406901edd73bed6b8f17754fa7809458cd90956128c56bf8ba49a401f62ace2e
```

The original server response sets both `error_code` and `binary_error_code` to
`SOURCE_HOST_DENIED`, with `isError=true`, stage and trace ID. The host adapter
may normalize its generic error field to `INVALID_ARGUMENT`; this does not
mean the PDF or size/hash arguments were malformed. `binary_error_code` is the
authoritative connector classification. New guidance makes that distinction
explicit, and connection status exposes effective source policy. Errors no
longer incorrectly say the file adapter supplied the URL when a caller used
the direct HTTPS route.

## Regression coverage

Twelve new tests cover configuration parity, effective diagnostic overrides,
exact hosts/lookalikes, and both MCP routes through the real streaming upload
implementation using synthetic fixture bytes and mocked upstream services.
Successful cases verify complete bytes and SHA-256; mismatch cases verify
no finalization, and hash mismatch cancels the upload session. Redirect escape
and private-DNS cases stop before upload session creation. Archive's allowed
redirect checks DNS at both hosts. Test-only native objects represent adapter
fixtures; they are not proof of a live host adapter selecting that region.

All 219 root tests, 25 Worker tests, four real workerd HTTP tests and two
independent-client/Python interoperability tests pass (250 total), as do both
type checks and the Node build. Targeted source-policy/error tests were rerun after the additional native
region was observed. Tests do not call the real adapter or kDrive unless explicitly
identified as live verification below.

Live verification and deployment status are recorded separately below; local
tests and a successful public download alone do not prove deployed uploads.

## Live verification before deployment

The patched local `kdrive_upload_from_url` handler used the normal source
validator and real kDrive client to upload the reproduction from Archive.org,
then independently downloaded the pinned kDrive version. Both upload and
readback matched 24,323,083 bytes and the expected SHA-256. The validation copy
is `ramanuja-adidevananda-url.pdf` in a new `Connector transfer validation
2026-10-19` subfolder of the user's Gita project. Existing corpus files and the
acquisition index were not changed. This is a real local-handler-to-kDrive
round trip, not a deployed Worker acceptance pass.

The actual native tool adapter was given the verified local PDF once, with the
same expected size/hash and a separate `ramanuja-adidevananda-native.pdf`
destination. The still-unpatched production connector rejected its newly
selected `sdmntprcacentral.oaiusercontent.com` host at `source_fetch`, trace
`a2bd1312-bc35-45c1-88d3-f716b64a17da`. No native PDF was committed. Its text
response retained `SOURCE_HOST_DENIED` in both error fields, while structured
content normalized only generic `error_code` to `INVALID_ARGUMENT`, directly
confirming the adapter behavior.

The newly observed host was DNS/TLS checked and added to the exact local policy.
No retry against the unchanged live policy was attempted. At that stage, full native and remote
URL acceptance required deploying the binary policy patch, then using the actual
adapter and comparing complete kDrive readbacks. The deployment hold and
binary-only proposal were subsequently superseded by the authorization below.

## Combined release authorization

On October 19 Max explicitly authorized publishing and deploying everything,
superseding the earlier deployment hold and binary-only proposal. The reviewed
release combines this policy fix, bounded OCR jobs and the white-page fix.
Deployment and post-release acceptance are recorded in the
[combined release record](combined-release-2026-10-19.md).
