# Security policy

## Credentials

Never commit Infomaniak access tokens, refresh tokens, OAuth client secrets, or a
populated `.env` file. The connector stores OAuth tokens outside the repository
and, on macOS, stores the OAuth client secret in Keychain.

If a credential is exposed, revoke or rotate it in Infomaniak immediately and
remove it from the repository history before continuing to use the connector.

## Operational logging

Normal connector and Worker logs are structured and privacy-preserving. They may
record operation and stage names, success or failure, a random correlation ID,
request duration, HTTP status, and bounded machine-readable error codes. They do
not record kDrive paths, item names, item IDs, operation targets, exception
messages or stacks, response bodies, credentials, authorization headers, or
signed operation and undo tokens.

There is no detailed diagnostic logging mode. Any future mode that includes more
context must be explicit, disabled by default, documented, tested, and must still
exclude credentials and signed tokens.

## Reporting a vulnerability

Because this is a private project, report security concerns directly to the
repository owner through a private channel. Include the affected version, a
minimal reproduction, and the expected security impact.
