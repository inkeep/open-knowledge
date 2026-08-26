---
"@inkeep/open-knowledge": patch
---

The terminal now says it is starting instead of showing an empty pane. Opening a terminal has always had a gap between the moment you ask for it and the moment the shell prints its first prompt: the project's local settings have to sync, the terminal's code has to load, a PTY host has to start, and your login shell has to run its startup files. On a cold start with a large project that gap can run for seconds, and the pane stayed completely blank for all of it, which is indistinguishable from a keystroke that did nothing. People reasonably concluded it had not worked and opened the terminal again, and again, ending up with several shells they did not want. The pane now shows a "Starting terminal" status for as long as it is waiting, and gets out of the way the moment the shell produces output. The notice fades in only if the wait is long enough to notice, so a fast terminal still opens without a flash, and it sits over the terminal area only, so the "Connect tools" and "Get Claude Code" prompts stay visible and clickable while the shell starts.

The wait itself is also shorter. Loading the terminal's code and syncing the project's settings do not depend on each other, but the code fetch only used to begin once the settings had arrived. It now starts right away, so the two happen at the same time instead of one after the other.
