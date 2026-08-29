---
"@inkeep/open-knowledge": patch
---

After an update installs, the next launch no longer asks you to report a crash, even if that launch is days later. Installing an update shuts the running app down so its files can be replaced, and the app used to recognize that shutdown as the installer's doing only if you reopened within half an hour. It now judges the previous session by when it actually ended rather than by how soon you came back, so reopening the next morning reads the same as reopening straight away. That holds whether or not the install landed.

A small number of update shutdowns can still produce the prompt. A real crash still prompts, and you can report one at any time from Help → Report a bug…
