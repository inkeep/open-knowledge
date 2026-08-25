---
"@inkeep/open-knowledge": patch
---

An update you downloaded is no longer thrown away when Windows ends your session, and the app no longer tells you an install failed when it never started one.

On Windows there were only two moments an update could actually install: you clicked "Relaunch now", or you quit the app and it installed on the way out. Shutting the machine down is neither. Windows terminates the app without giving it the chance to run its quit steps, so the update was silently discarded — and because the app had already recorded that an install was underway, the next launch reported a failure for something that had never been attempted.

For anyone who leaves the app open and shuts the laptop down rather than quitting, that repeated every time, so they never got an update at all. After three launches the failure notice gave up and went quiet too, leaving no sign that an update was sitting there ready to install.

The app now tells the two situations apart. An install that was genuinely handed over and did not take is still reported as a failure, unchanged. An update that no quit ever committed is recognized as still waiting, and is offered again the ordinary way — the same "ready to install" prompt you would have seen after the download — for as long as it is waiting. Nothing installs without you choosing it.
