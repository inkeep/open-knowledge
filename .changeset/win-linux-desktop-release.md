---
"@inkeep/open-knowledge": patch
---

The desktop app now ships for Windows and Linux, with auto-update on every platform. Each release publishes signed Windows installers (x64 and ARM64) and Linux `.deb`/`.rpm` packages (x64 and ARM64) alongside the macOS DMG, all attached to the GitHub Release. Installed apps update themselves: Windows updates install silently like macOS, and Linux updates download the new package and ask for your password to install it (via the system's polkit prompt) — no apt/rpm repository to configure.
