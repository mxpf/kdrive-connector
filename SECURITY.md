# Security policy

## Credentials

Never commit Infomaniak access tokens, refresh tokens, OAuth client secrets, or a
populated `.env` file. The connector stores OAuth tokens outside the repository
and, on macOS, stores the OAuth client secret in Keychain.

If a credential is exposed, revoke or rotate it in Infomaniak immediately and
remove it from the repository history before continuing to use the connector.

## Reporting a vulnerability

Because this is a private project, report security concerns directly to the
repository owner through a private channel. Include the affected version, a
minimal reproduction, and the expected security impact.
