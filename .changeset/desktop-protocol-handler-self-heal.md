---
"@inkeep/open-knowledge": patch
---

Fixed `openknowledge://` deep links (used by `ok open`, `ok <file>`, and shared links) sometimes opening a blank, unbranded Electron window instead of the OpenKnowledge desktop app.

This happened when a development build of the desktop app had run on the machine at some point and registered itself as the handler for `openknowledge://` links, then exited without cleanly unregistering — for example, if the process was killed rather than quit normally, or its checkout was later deleted. macOS kept routing links to that no-longer-valid registration instead of the installed app. The desktop app now re-claims its link handling every time it starts, the same way it already did on Windows and Linux, so a stale registration from an old development run gets corrected automatically the next time you open the app.

On macOS, `ok open` and `ok <file>` no longer depend on that registration being correct in the first place: when a desktop install is found, they open it by its exact file-system location rather than asking macOS to figure out who owns `openknowledge://` links, so they keep working even if a stale registration exists and the app hasn't been opened yet to repair it. Windows and Linux still resolve the link through the OS's own registration and rely on the per-boot repair above; making them equally independent of that resolution is tracked as a follow-up.

Also worth knowing if you're developing the desktop app itself: a development instance still claims `openknowledge://` machine-wide on macOS while it's running (needed so `open openknowledge://...` reaches the dev build during local testing), and now competes with the packaged app's own per-boot repair for the same registration — whichever one started most recently wins. A browser-clicked link between an unclean dev-mode exit and the next time you launch the installed app by hand may briefly reach the wrong place; opening the installed app once corrects it.
