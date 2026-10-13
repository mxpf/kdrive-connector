# Synthetic PDF fixtures

These contain only synthetic text, including `Verification phrase: ORCHID-7319`.
No personal, financial, tax, or copyrighted source documents are included.

Generated with ReportLab (letter page, Helvetica, invariant metadata) and pypdf
6.10.0. The protected copy uses AES-256. Its test-only open password is
`synthetic-open-password`; owner password is `synthetic-owner-password`.
These are fixture constants, never credentials. Encryption uses random salts,
so regeneration changes the protected file hash. Both fixtures have one page.

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `ordinary.pdf` | 1562 | `d64779de9e9cecdfc184e2a9885a84a71374a5b3d4ea89ae61f71d0026b87184` |
| `password-protected.pdf` | 2688 | `edd986d5c8aa4d7262af65a403e49fc7e96a1e70be490df4d293f00a5c0d9750` |

`npm run test:pdf` runs actual loopback HTTP requests with Node, curl, and Python,
compares complete bytes and SHA-256, and uses an independent pypdf parser on the
received file. It checks ordinary text extraction, incorrect-password rejection,
and successful extraction with the known password. It also checks tampering,
expiry, unsupported methods, and corruption. The loopback test does not prove
production TLS or third-party tool ingestion; those are recorded separately in
`docs/binary-interop-0.3.1.md`.

Install test-only parser dependencies with
`python3 -m pip install -r test/integration/requirements.txt` (prefer a virtual
environment). Set `KDRIVE_TEST_PYTHON` to that environment's Python executable if
needed. Production connector code has no Python dependency. CI runs these checks
on macOS and Ubuntu. No live kDrive uploads or cloud credentials are used.
