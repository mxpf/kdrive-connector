---
name: manage-kdrive-files
description: Find, read, summarize, create, upload, rename, move, replace, trash, and restore files in Infomaniak kDrive. Use whenever the user mentions kDrive, provides a known kDrive path such as /Private/..., or asks to continue a kDrive file workflow, including natural requests to find a document, save finished work, organize folders, or update an existing file.
---

# Manage kDrive Files

Use the kDrive MCP tools as a natural file workspace. Work entirely with paths and filenames. Keep connector internals out of the conversation.

## Choose the workflow

- To find something, search by the user's words and narrow by a known folder path when useful. Use the returned preview to distinguish likely matches. If multiple plausible results remain, show concise paths or ask one short clarifying question.
- To inspect a known location, list or read it by path.
- To create or upload, prefer a complete destination path. New files must use conflict-safe behavior unless the user explicitly asks for an automatically renamed copy.
- To rename, move, replace, or trash, call `kdrive_prepare_change` internally and immediately follow it with the matching write tool using the returned operation token and identical readable arguments.
- To replace contents, keep the connector's target and version binding enabled. Never convert an upload into an overwrite.
- To remove an item, use recoverable trash. Never describe it as permanent deletion. Keep the returned undo token internal for a possible restore.
- To undo a trash action, call the restore tool with the internal undo token from the trash result.

## Interaction rules

1. Treat an unambiguous user request as the instruction for that exact operation. Let the host show one normal approval for the write when required.
2. Never ask the user to copy or type a confirmation phrase, ID, ETag, operation token, or undo token. Do not expose those values in the answer.
3. If the user asks to preview, prepare, explain, or show what would happen, do not call `kdrive_prepare_change` or a write tool. Describe the proposed change in plain language.
4. Do not broaden a write. For example, “rename this file” does not authorize moving its folder or replacing its contents.
5. Report outcomes with names and paths. When useful, render the returned URL as `[Open in kDrive](...)`; never create a public share link merely to make a result clickable.
6. Preserve existing files by default. Do not convert an upload into an overwrite, and do not retry a conflict with a more destructive operation without asking.

## Result style

Lead with the outcome. Keep routine results short: what was found or changed, the path, a short preview when useful, and an Open in kDrive link. Avoid narrating the internal prepare call or connector internals.

## Selection boundaries

- Direct triggers: “in kDrive,” “my Infomaniak drive,” “under /Private/...,” or a prior kDrive result in the same workflow.
- Indirect triggers: “save this there,” “move that invoice,” or “open the file” when the active context already identifies kDrive.
- Negative triggers: a generic request about “my files” with no kDrive context, Google Drive, Dropbox, a local folder, or an email attachment. Use the named source or ask one short source question.
