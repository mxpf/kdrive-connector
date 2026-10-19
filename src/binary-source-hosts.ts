// Exact provider hosts reviewed from observed adapter URLs; no suffix trust.
export const NATIVE_FILE_SOURCE_HOSTS = ["files.oaiusercontent.com", "sandbox.openai.com", "sdmntprcentralus.oaiusercontent.com", "sdmntprnorthcentralus.oaiusercontent.com", "sdmntprsoutheastus3.oaiusercontent.com", "sdmntpreastus2.oaiusercontent.com", "oaisdmntprnorthcentralus.blob.core.windows.net", "sdmntprbrazilsouth.oaiusercontent.com", "sdmntprsouthcentralus.oaiusercontent.com", "sdmntprwestus.oaiusercontent.com", "sdmntprnortheu.oaiusercontent.com", "sdmntprwestus2.oaiusercontent.com", "sdmntprcacentral.oaiusercontent.com"] as const;

// Archive.org metadata lists the two ia mirrors; its HTTPS download redirect
// selected dn760102 on 2026-10-19. All three returned its expected byte length.
export const ARCHIVE_SOURCE_HOSTS = ["archive.org", "dn760102.eu.archive.org", "ia600901.us.archive.org", "ia800901.us.archive.org"] as const;
export const DEFAULT_BINARY_SOURCE_HOSTS = [...NATIVE_FILE_SOURCE_HOSTS, ...ARCHIVE_SOURCE_HOSTS] as const;
