---
"@inkeep/open-knowledge": minor
---

The OpenKnowledge desktop app can now be built for Windows and Linux. This first slice makes the app buildable and full-featured on both platforms — installers are not published yet (they'll appear on the releases page after internal QA):

- Windows: one-click per-user NSIS installers (x64 + arm64) that put the bundled `ok` CLI on your PATH and register `openknowledge://` links. Linux: AppImage and deb packages (x64 + arm64); the deb installs `/usr/bin/ok` and registers links system-wide, while AppImages self-register a link handler each time they run.
- Windows and Linux windows get proper chrome: a frameless titlebar with native window controls and an in-app menu bar (File / Edit / View / Window / Help) that mirrors the macOS menus.
- Everything the Mac app wires up on your machine now works on Windows and Linux too: MCP entries for your editors (Claude, Cursor, Codex, and friends), Agent Skills, and `ok` launching the desktop app when installed.
- The built-in terminal stays macOS-only for now; its buttons and settings are hidden on other platforms instead of failing.
