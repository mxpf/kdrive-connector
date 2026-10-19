# Combined release — October 19, 2026

Status: **published and deployed; binary acceptance passed; ChatGPT OCR
acceptance blocked by host access/tool refresh**. This record does not claim
that the post-deployment real-page OCR gate passed.

## Release and plan

Max explicitly authorized publishing and deploying all pending changes on
October 19. The release includes exact binary source-host corrections,
bounded OCR jobs and polling, and deterministic empty results for entirely
opaque-white rendered selections. Existing text/form reading, version pinning,
redirect validation and size/hash enforcement are preserved.

- Source commit: [`6701a4b`](https://github.com/mxpf/kdrive-connector/commit/6701a4b26b0522ff43f51bb41cf7891be33bfaab), pushed to `main`.
- [CI run 39249307218](https://github.com/mxpf/kdrive-connector/actions/runs/39249307218): successful on both Ubuntu and macOS before deployment.
- Local validation: 219 root tests, 25 Worker tests, four real workerd HTTP tests,
  two independent-client/Python integration tests; both type checks and build pass.
- Worker version: `f19c3e4e-0da1-4e26-b8e7-e60bd8458a14`.
- Capability revision: `2026-10-19.2`; binary source policy: `2026-10-19.1`.
- Bundle: 11,277.57 KiB uncompressed / 3,657.24 KiB gzip; startup 63 ms.
- Cloudflare dashboard checked immediately before deployment: **Free, $0,
  Current plan**. No upgrade, new paid service, binding or storage migration.
- Live connection status verified the new build, `pdf_ocr=true`,
  `pdf_ocr_jobs=true`, three-minute OCR job deadline and reviewed exact host list.

The pre-release rollback target is `9dd6d9ed-d4a2-467f-9c97-89b9261d0e0f`.
No rollback has been performed: live binary checks passed, and the OCR check
has not executed because of a host-level blocker. A connector acceptance
failure requires rollback rather than declaring success.

## Production binary acceptance

Both actual connected tools ran against the deployed Worker, with expected
size and SHA-256 supplied. They created distinct copies in the Gita project's
`Connector transfer validation 2026-10-19` folder, without overwriting corpus
files or changing the acquisition index.

| Route | Validation file | Production trace | Result |
| --- | --- | --- | --- |
| Native host adapter | `ramanuja-adidevananda-native.pdf` | `1050334c-b060-4dfd-8b57-d8c4767f8c31` | Uploaded and full-byte readback verified |
| Archive.org HTTPS | `ramanuja-adidevananda-remote-url.pdf` | `0ff521b4-6bf6-426c-bc32-4d37943683f8` | Uploaded and full-byte readback verified |

An independent local kDrive client resolved each new file's version, streamed
its complete bytes and calculated SHA-256. Both matched the public reproduction:

```text
size_bytes: 24323083
sha256: 406901edd73bed6b8f17754fa7809458cd90956128c56bf8ba49a401f62ace2e
```

This verifies both upload routes end to end for the requested reproduction.
It does not establish that all 34 acquisition files or all Archive mirrors
have been tested. Unreviewed redirect hosts still fail closed. See the
[source-policy investigation](binary-source-policy-2026-10-19.md).

## Remaining ChatGPT OCR gate

The existing OCR acceptance conversation was asked to verify the new build,
confirm the polling tool exists, and read the previously authorized blank and
nonblank pages sequentially. The ChatGPT host entered `systemError` without a
new completed test turn. The browser was signed out, and this task's cached
connector catalog still lacked `kdrive_get_pdf_ocr_result`.

User sign-in and **Refresh tools** were requested. No new OCR result or inference
was available from that attempt. This is a host access/catalog blocker, not
an observed Worker OCR timeout. Earlier local real-binding successes remain
[separate evidence](ocr-timeout-2026-10-14.md), not a substitute for this gate.

After refresh, run one read per page and poll each job to completion; do not
repeat the read or inference. Verify the complete-file digest, renderer-sourced
empty text for the blank page, and nonempty reviewed OCR for the other page.
Compare native/OCR monetary-value counts without publishing private values.
Stop and roll back on connector failure. The original PDF must remain unchanged.

No private document, extracted text, identifier, path or private digest is
included in this release record.
