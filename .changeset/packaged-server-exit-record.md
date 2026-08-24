---
"@inkeep/open-knowledge": patch
---

Bug reports filed from an installed desktop app now say how the background server died. The app has recorded that for a while, but only in development builds: installed builds start the server as an ordinary background process rather than as one of the app's own child processes, and the code that wrote the record was wired only to the second kind. Every bug report from an installed build was therefore missing the one file that answers "did the server crash, or was it shut down on purpose", which is the question the record exists to settle. It is now written on both paths.

The record also names the signal that ended the process. A server killed outright leaves no exit code at all, so until now the death this feature was built for was the one it could not describe: the record looked the same as an exit for no stated reason. Records written by older versions simply have no signal in them, which reads as unknown rather than as "none".

Two honest limits worth stating. Where the app can classify a death itself it still does, but an installed build cannot classify this kind of process, so that field is now recorded as empty rather than filled in with a classification belonging to some other part of the app. The record now says which of the two it was, so an empty classification can be read as "there was never one to have" instead of "we looked and found nothing". And the record only covers a server this session started; when the app reconnects to a server that was already running from an earlier session, there is nothing watching it, so its death still leaves no record.

Nothing new is collected about you or your documents. The record holds a timestamp, the process id, the exit code, the signal that ended it, and which part of the app was watching. It stays on your machine unless you send it. Running `ok diagnose bundle` yourself includes it, and so does a bug report filed with detailed diagnostics turned on; an ordinary bug report does not carry it yet.
