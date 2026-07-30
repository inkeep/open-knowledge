---
"@inkeep/open-knowledge": patch
---

Fixed the Linux desktop packages (`.deb` and AppImage), which installed successfully and then failed to start. Launching the app did nothing at all — no window, no error dialog — because the packaged bundle was built without its runtime dependencies, so the app exited on its first import before it could show anything. Linux packages now ship their dependencies and launch normally. macOS and Windows builds were never affected.
