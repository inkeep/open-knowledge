---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Raise the dev-mode utility-process init budget to 20 s.

This affects unpackaged Electron runs only, `pnpm --filter=@inkeep/open-knowledge-desktop run dev` and the Playwright smoke harness. Packaged installers wire `spawnDetachedServer` and take the detached-spawn path, whose separate budget this change does not touch.

On the dev path, opening a project window forks the utility process that hosts the project's server and waits for it to report ready. That wait was capped at 15 s. When the cap fired, opening the project failed with `utility init timed out after 15000ms` and the app fell back to the Navigator. The cap is now 20 s, so an init that needs longer than 15 s still gets its window.

The `desktop-utility-wait-progress` heartbeat in the boot log carries the active cap as `initTimeoutMs`; it now reads 20000.

This raises the budget, it does not make init faster. An init slower than 20 s still ends in the same fallback with the new figure in the message.
