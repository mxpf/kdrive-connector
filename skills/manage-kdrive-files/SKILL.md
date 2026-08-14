---
name: manage-kdrive-files
description: Find, read, summarize, create, upload, rename, move, replace, trash, and restore files in Infomaniak kDrive. Use whenever the user mentions kDrive or asks to work with files stored there, including natural requests such as finding a document, saving finished work, organizing folders, or updating an existing file.
---

# Manage kDrive Files

Use the kDrive MCP tools as a natural file workspace. Keep technical identifiers out of the conversation unless the user asks for them.

## Choose the workflow

- To find something, search by the user's words and narrow by a known folder path when useful. If multiple plausible results remain, show concise paths or ask one short clarifying question.
- To inspect a known location, list or read it by path. Use IDs only as an internal fallback.
- To create or upload, prefer a complete destination path. New files must use conflict-safe behavior unless the user explicitly asks for an automatically renamed copy.
- To rename or move, resolve the source and destination by path and execute only the exact change the user requested.
- To replace contents, use the overwrite tool. Its current-ETag check must remain enabled.
- To remove an item, use recoverable trash. Never describe it as permanent deletion. Keep the returned restore ID available for a possible undo.
- To undo a trash action, restore with the restore ID returned by the trash result.

## Interaction rules

1. Treat an unambiguous user request as the instruction for that exact operation. Let the host show its normal approval UI when required.
2. Never ask the user to copy or type a confirmation phrase, file ID, folder ID, or ETag.
3. If the user asks to preview, prepare, explain, or show what would happen, do not call a write tool. Describe the proposed change in plain language.
4. Do not broaden a write. For example, “rename this file” does not authorize moving its folder or replacing its contents.
5. Report outcomes with names and paths. Mention internal IDs or ETags only when the user explicitly requests diagnostic details.
6. Preserve existing files by default. Do not convert an upload into an overwrite, and do not retry a conflict with a more destructive operation without asking.

## Result style

Lead with the outcome. Keep routine results short: what was found or changed, the path, and any useful next step. Avoid narrating tool calls or connector internals.
