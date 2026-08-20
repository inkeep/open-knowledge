---
"@inkeep/open-knowledge": patch
---

In-app agents are no longer marked Beta, and the native **File → Open with AI** menu item now picks the same agent every other launcher does. That menu item used to jump straight to the first installed external app, so it could open a different agent than the sparkle menu right beside it; it now goes through the shared launcher selection — your saved choice first while it is still enabled, otherwise an in-app agent, then a terminal CLI, then an external app. Terminal and external apps remain available everywhere they were, and an explicitly chosen one stays chosen. The Beta badge and the "In app (beta)" screen-reader label are gone from the agent menus and from Configure agents; the unrelated beta-channel and plugin Beta markers are unchanged. Editor and getting-started documentation now describes the in-app route and the current menu order instead of the old installed-app default.
