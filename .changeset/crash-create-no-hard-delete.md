---
"@inkeep/open-knowledge": patch
---

Stop an app-shell crash from deleting a file you are in the middle of creating, and stop the crash-recovery button from walking you back into the same crash.

If the app shell crashed while an inline file or folder create was still open, the crash unmounted the file tree and its cleanup hard-deleted the file you had just made. The cleanup could not tell an error-boundary unmount apart from you cancelling the rename, so it deleted in both cases. The two are now distinct intents. Cancelling a rename still removes the placeholder exactly as before, including the delete and the return to your previous location. A crash or an ordinary unmount now leaves the created file exactly where it was created. It is not deleted and it is not moved to Trash, because a crash is not a retraction of your request to create the file.

A cleanup failure is now reported to a log channel that lands in the diagnostics bundle, carrying the file kind and path, so a cleanup with no surviving UI to show a toast no longer fails silently. Reporting a failure is no longer tied to whether the cleanup can update the UI.

On the recovery side, the app-shell error screen's Try again no longer replays the document that caused the crash. Previously it remounted the app, which re-read your saved tab session and reopened the very document that had just crashed, so Try again deterministically re-crashed. A repeat crash on the same error now skips the saved tab session restore, and the app comes back without the crashing document. This covers both ways a session is restored, the synchronous web path and the desktop session state, so it holds in the packaged desktop app and not only in the browser. When a restore is skipped, a notice tells you that your last open document could not be restored, so the empty workspace reads as a deliberate recovery rather than a forgotten tab. The notice is translated in every supported locale.

A recovery that skips the restore also stops saving your tab session for the rest of that recovery, so the tabs you had before the crash are still waiting for you the next time you launch. Without that, the first document you opened after the recovery would be written over the whole stored session and every other tab, pin and split would be gone.

Known limitation: the skip lasts for the current session only, so it never becomes permanent and a later reload restores your tabs normally. The trade-off is that if the crashing document is still the one saved in your tab session, relaunching the app can reopen it and reproduce the crash. Durable recovery needs to identify the offending document reliably, which the app-shell error boundary cannot do today because it also catches crashes that originate outside the document view.

The delete endpoint itself and the underlying render loop that triggered these crash reports are unchanged.
