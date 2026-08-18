---
"@inkeep/open-knowledge": patch
---

Reopening the app while a macOS update is still installing no longer shows a false "Update to X didn't install" notice, and no longer spends one of the three chances that notice gets. The install runs after the app quits, inside a separate process the next launch cannot see, so reopening a minute later booted the old version and that was read as a failed install. It was also self-defeating: the reopen is what interrupts the install, and an interrupted attempt re-stages, so the update being declared dead is the one that would have landed on the next quit. The app now holds the verdict while the install may still be underway, and reports a genuinely failed install on a later launch instead.

The wait now runs from the moment the install actually starts, which is when you quit or click Relaunch now, rather than from when the download finished. An update that downloaded quietly in the background hours before you quit still gets the full window.
