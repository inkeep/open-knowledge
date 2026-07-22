---
"@inkeep/open-knowledge": patch
---

The desktop app no longer invites you to file a bug report after it was asked to quit by a termination signal (a macOS logout, `killall`, Activity Monitor's "Quit", or a parent process stopping it). These signals are an orderly request to stop, not an app crash, but the main process previously exited without running its clean-quit path — so the dirty-shutdown sentinel was left behind and the next launch misread the session as a crash. The main process now handles SIGTERM/SIGINT/SIGHUP by clearing the sentinel and quitting cleanly. Genuine app crashes still prompt exactly as before, and a crash that produced a crash dump is still detected on the next boot.
