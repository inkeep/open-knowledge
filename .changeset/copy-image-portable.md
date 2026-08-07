---
'@inkeep/open-knowledge': patch
---

Copying an image from a doc (Cmd+C after selecting the image) now pastes as an actual image everywhere. Before, most destinations either pasted the image's alt text as plain text (Slack chat, plain textareas), showed a gray box that never loaded (Google Docs), or a broken-attachment placeholder (Apple Notes). The Electron desktop app now writes the same 9-flavor raster set a macOS screenshot puts on the clipboard, so Notes, Docs, Slack, Notion, iMessage, and every other rich-text destination render the pixels inline first-try.
