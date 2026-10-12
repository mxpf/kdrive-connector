# Report: ChatGPT Adobe upload bridge input-schema mismatch

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
