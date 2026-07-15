---
"@inkeep/open-knowledge": patch
---

Inline images now render in desktop windows attached to a server the desktop did not spawn (MCP-autostarted or terminal `ok start`). Every server now serves content-directory assets (images, video, audio, PDF, file attachments) at their `/<contentDir-relative>` paths by default, through the same admission middleware `ok ui` uses (inline/attachment dispatch, fail-closed 404 for missing assets). Previously only desktop-spawned servers passed `--serve-content-assets`, so a desktop window attaching to an MCP-spawned server resolved image srcs against an origin that 404'd them, showing broken images for every inline image in the project. The flag is still accepted for compatibility; pass `serveContentAssets: false` to `bootServer` to opt out. Servers that don't serve the React shell keep the `ok ui` pointer hint in their catch-all 404.
