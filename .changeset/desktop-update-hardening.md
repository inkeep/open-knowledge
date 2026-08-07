---
'@inkeep/open-knowledge': patch
---

Desktop: harden updates, reclaim the updater cache, and remove packaged-startup warnings.

- Linux: when no graphical administrator authorization is available (no pkexec or PolicyKit agent), clicking Relaunch now shows a dismissible manual-install dialog with a copyable, shell-quoted package-manager command (`sudo apt install -- '<installer>'` / `sudo dnf install '<installer>'`) and an unconditional Relaunch button, instead of failing through terminal sudo. Cancelling the authorization prompt re-arms the update banner without the dialog; the staged installer is preserved until an install succeeds or a newer update replaces it.
- All platforms: the updater cache's staged installer (`pending/`, ~250 MB) is reclaimed once the installed version is running. Windows additionally stops retaining the NSIS installer's inert differential-update seed copy (`installer.exe`, ~250 MB) at install time. macOS keeps its separate `update.zip` differential-download seed — that copy actively shrinks future mac update downloads and is intentionally untouched.
- Packaged startup no longer emits the duplicate-Yjs warning (the `@inkeep/open-knowledge` library entry now resolves the shared `yjs` from node_modules; the standalone CLI binary still inlines it) or the `No handler registered for 'ok:...:renderer-ready'` errors (a permanent mount-ack sink now absorbs unarmed renderer-ready pings).
