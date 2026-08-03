---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-server": patch
---

Route the Vite development server through the same collaboration WebSocket host as `ok start`, so `/collab`, `/collab/keepalive`, and `/collab/thread` share admission, message-size, presence-cleanup, and shutdown behavior. This removes the duplicated upgrade stack that could drift between development and production.
