---
'@inkeep/open-knowledge': patch
---

Auto-update telemetry now reports which platform and version an update landed on. The desktop updater tags each artifact fetch with the version it is installing, and the update proxy records the operating system and architecture alongside the artifact type. Previously only the macOS zip carried a version — the Windows and Linux installers use version-less names that stable resolves through GitHub's `latest` alias, so every Windows and Linux stable update was counted with no version at all, and architecture was invisible on every platform. The new header is sent only when the updater is pointed at the openknowledge.ai proxy, never on the GitHub fallback, and the proxy prefers the version it can derive itself over the one the client claims.
