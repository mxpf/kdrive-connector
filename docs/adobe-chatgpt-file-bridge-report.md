# Report: ChatGPT Adobe upload bridge input-schema mismatch

Update (2026-10-13): [direct connector PDF extraction](pdf-extraction.md) now
bypasses this handoff for supported reading tasks. It was deployed and exercised
in ChatGPT on October 13; the Adobe attachment-import issue described below remains open.

Status: **submitted to OpenAI Help Center and escalated to a support specialist** on 2026-09-29. Support confirmed replies will also arrive by email; no case number was displayed. Not submitted separately to Adobe.

The submission included the sanitized reproduction, request IDs, conversation ID and runtime details below. A follow-up clarified that the estimated incident time was not a verified trace timestamp and that this is an MCP/app integration, not a legacy GPT Action. The automated support suggestion involving `openaiFileResponse` was not treated as a verified MCP fix or implemented. No signed download URLs, credentials or PDF contents were sent.

## Summary

A private MCP connector exports a short-lived raw HTTPS PDF reference. In ChatGPT, Adobe's exposed `asset_openai_file_upload` bridge rejected its input with:

```text
files.0: Invalid input: expected object, received string
```

The conversation reports that its callable `files` schema accepts strings, but the underlying validator expects structured native file objects. Please correlate the actual exposed schema and bridge transformation with server validation; we cannot inspect Adobe's internal implementation.

## Reproduction

1. Enable the private kDrive Connector and Adobe Acrobat in ChatGPT; authenticate both.
2. Export an existing PDF using `kdrive_export_file`, without inline base64 or a preview-page URL.
3. Use the available Adobe upload bridge to ingest the reference and obtain a genuine Adobe asset before conversion.
4. Observe the input-validator error above. Do not fabricate a native file ID or asset URN.

Expected: either a supported raw-file-to-Adobe-asset import, or a consistent native-file schema and clear statement that an existing ChatGPT file ID is required.

Actual: validation stops the bridge before extraction. The ChatGPT run reports no independently downloaded/hashed file and no successful `pdf_to_markdown` call through this route.

## Additional evidence

- Observed 2026-09-29 in ChatGPT conversation **Export PDF metadata** (desktop UI; same conversation inspected on web).
- Exported PDF: `application/pdf`, 487461 bytes. Signed URL and document contents intentionally omitted.
- Earlier direct HTTPS → `pdf_to_markdown` failed with HTTP 400, `MISMATCHED_INPUT_STORAGE_TYPE`, tracking ID `bdc7b50c-bc77-11f1-abea-c95eb7e1394a`. This is a separate failure from the upload-bridge validator error.
- Codex successfully downloaded and verified the same PDF, then used its local-path host-managed upload adapter with Acrobat; extraction succeeded after reauthentication. Successful request ID: `6ddf94bf-8fd0-4679-bd03-811f39d529f8`.
- Two one-time materialization approvals appeared during the ChatGPT bridge test; their cause is not yet established.

## Requested investigation

Please verify agreement between model-visible file inputs, host file-reference transformation, and Adobe's structured-file validator. Identify a supported way for a custom MCP raw export to become an accepted Adobe asset without manual re-upload or binary payloads in model context. Clarify whether arbitrary HTTPS import is supported or only native ChatGPT files/provider-specific URLs.

OpenAI's [file-input contract](https://developers.openai.com/plugins/reference#define-file-inputs) describes structured objects with required `file_id` and `download_url`. This does not itself establish that ChatGPT can mint native file IDs for arbitrary MCP exports. Adobe's [external-storage documentation](https://developer.adobe.com/document-services/docs/overview/pdf-services-api/howtos/pdf-external-storage-sol) describes provider-specific storage support; it is not proof of this connector's internal implementation.

No kDrive changes were made in the export/Acrobat tests. Please request sanitized traces if needed; do not include bearer download URLs, OAuth tokens, cookies, or private PDF contents in support tickets.

## 2026-10-13 contract investigation

**Outcome: the automatic ChatGPT-to-Adobe import is still unresolved.** This
follow-up inspected current public contracts and available tool declarations;
it did not reproduce the historical upload-validator failure in classic
ChatGPT. No new support message was sent. The earlier submission status above
is historical, not a fresh support-status check.

The [0.3.1 investigation](binary-interop-0.3.1.md) independently verified raw
delivery and extraction through Codex's local-file adapter. That proves the
transport and that specific adapter, not native attachment creation in every
ChatGPT host. The currently exposed Acrobat tools in this Codex session accept
host-adapted local paths; the historical `asset_openai_file_upload` tool is not
exposed here. `document_upload` is an interactive local-file picker, not a
remote URL import endpoint.

### Candidate routes and their limits

| Route | Finding |
| --- | --- |
| MCP export → native attachment | The [OpenAI reference](https://developers.openai.com/plugins/reference#define-file-inputs) documents native file **inputs**, but supplies no verified arbitrary-URL-to-conversation-file output contract. The connector cannot mint a native file ID. |
| Widget `uploadFile` | The same reference describes uploading a user-selected file and returning a file ID. It does not establish automatic remote PDF import and authorization for a different plugin. A widget prototype would still need real cross-plugin acceptance evidence. |
| File extensions | The [OpenAI MCP extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md) scopes file entrypoints to desktop and excludes classic ChatGPT from its platform matrix. `openai/resources/write` can modify only the resource supplied to the file entrypoint; it is not a general attachment-creation API. |
| GPT Action `openaiFileResponse` | [Action file responses](https://developers.openai.com/api/docs/actions/sending-files) can create conversation files, but this is a different integration contract. [GPT configuration](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts) permits apps or actions, not both, so switching to an Action does not establish a bridge to the Adobe app. |
| Worker URL → Adobe external storage | Adobe's [PDF Services external-storage contract](https://developer.adobe.com/document-services/docs/overview/pdf-services-api/howtos/pdf-external-storage-sol) lists SharePoint, S3, Dropbox and Azure Blob URL formats. Our Worker URL is outside those formats. This is consistent with `MISMATCHED_INPUT_STORAGE_TYPE`, but does not prove Acrobat's internal implementation. |

A separate Adobe PDF Services integration would be a different architecture
with its own credentials, service terms and processing path. It would not repair
the connected Adobe app's native-file adapter. No such integration, new storage
service, public rehosting, or speculative output metadata was added.

### Changes and completion requirements

The shared server instructions and export-tool description now require checking
the receiving host's import capability for Adobe. They discourage repeated
exports, incompatible storage-type retries and invented file or asset IDs.
Capability revision `2026-10-13.2` identifies this guidance change; it does not
advertise a new binary-import capability.

To finish the requested workflow, obtain a supported host import operation that
turns verified export bytes into a genuine native file accepted by the connected
Adobe app, or a supported Adobe ingestion operation for this export format.
Reconcile the host's exposed schema with its native-file transformation. Then
verify in the target ChatGPT host, using synthetic fixtures:

1. Locate and export an ordinary PDF; independently check complete bytes and
   SHA-256.
2. Import it without user download/re-upload; obtain a real native file or Adobe
   asset through the supported operation.
3. Extract `ORCHID-7319` from the ordinary fixture through Adobe.
4. Test an encrypted fixture through supported password handling, including
   missing and incorrect passwords, without logging passwords or contents.
5. Verify expired references fail and refreshed references retain the expected
   version and digest.

Local mocks cannot certify steps 2–4 in ChatGPT. The full acceptance criterion
remains open. Cloudflare Free configuration is unchanged. This follow-up made
no deployment, live upload, or private-document transfer.
