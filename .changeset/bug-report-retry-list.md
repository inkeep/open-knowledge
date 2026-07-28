---
"@inkeep/open-knowledge": minor
---

Report a bug now keeps a history of your reports so a send that fails (or a dialog you closed) no longer means starting over. Each report you generate is saved with its last-known state, and you can find it again from a new "Bug report history" command in the palette or from a "Previous reports" section in the Report a bug dialog. From the list you can retry sending an existing report without regenerating it, reveal its file in Finder, or delete it. Retry re-sends the exact bundle you already made, so a report that failed the first time can reach the team on the next try, and the history survives closing the dialog and restarting the app.

Reports are also cleaned up automatically. Once a report is confirmed sent, its (potentially large) zip is reclaimed from disk while a lightweight record of the send is kept, and unsent reports are bounded so old bundles do not pile up. The most recent report you have not sent is never removed. Everything stays on your Mac, redaction is unchanged, and reports are only ever sent when you choose to send them.
