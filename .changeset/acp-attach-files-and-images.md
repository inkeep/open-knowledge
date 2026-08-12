---
'@inkeep/open-knowledge': minor
---

Files, folders, and images now ride ACP prompts. The agent-thread composer accepts three attachment paths — `@` picks workspace files and folders from the shared mention menu, the `+` button opens the OS file picker, and files dropped anywhere on the chat panel attach the same way. Non-image files stay workspace-scoped (matching Zed's behavior: the agent's tools can only reach files inside your project), so anything dropped from outside gets refused up front with a clear message. Images drop or paste from anywhere in the OS and preview as thumbnails above the input, with per-file type + size validation and a remove control.

On send, chips become native ACP parts alongside the text — `EmbeddedResource` with the file's text contents when the agent advertised `promptCapabilities.embeddedContext`, `ResourceLink` (with a `file://` URI + name + mime) otherwise; folders always as a directory reference; images as `ImageContent` when the agent advertised `promptCapabilities.image`. Agents that didn't advertise image support get a "doesn't accept images" refusal on the drop. Sent messages replay their attachments as chips in the transcript so a reloaded thread shows exactly what was handed to the agent.
