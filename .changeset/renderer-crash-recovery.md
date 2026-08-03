---
"@inkeep/open-knowledge": patch
---

A window whose renderer stops responding now recovers itself instead of going blank. Chromium occasionally tears down the process that draws a window; the frame stays and nothing paints in it. OpenKnowledge noticed this and filed it for a crash report, but did nothing about the window, so it stayed empty until you happened to try Cmd-R. There was no message and no visible way back — one report described coming back from a short break to an empty window and reloading on a guess, unsure whether that would take the running agent and a session of unsaved comments with it.

The window is now reloaded automatically the moment its renderer dies. If it dies a second time within a minute, the reload stops rather than looping, and a dialog offers to reload it or leave it alone. A window that dies repeatedly but slowly enough to keep dodging that minute is caught as well, after a few recoveries. That dialog also says what the blank window could not: documents and running agents live in the OpenKnowledge server, not in the window, so reloading restores the view without interrupting them.
