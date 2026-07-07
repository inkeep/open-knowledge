---
'@inkeep/open-knowledge': patch
---

`bun install` on a fresh clone no longer fails on machines without a C build toolchain. The desktop app's `node-pty` native dependency is now optional (its build is only needed for the macOS desktop terminal), and puppeteer's Chrome-for-Testing download (~600 MB on disk) — used only by an engineer-local memory probe — is skipped at install time (`bunx puppeteer browsers install chrome` fetches it on demand).
