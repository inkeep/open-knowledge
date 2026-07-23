---
"@inkeep/open-knowledge": minor
---

Ask why on uninstall. After a successful uninstall, in the macOS desktop flow and `ok uninstall`, an optional, skippable feedback screen asks one reason you're leaving, plus an optional note and an optional email for follow-up. It's shown only once removal succeeds, never blocks or cancels the uninstall (closing the window or interrupting the CLI just proceeds), and submissions reuse the existing feedback intake, tagged so churn feedback is filterable on its own.

The desktop "OpenKnowledge files were removed" screen is also redesigned as a scannable checklist (kept your content / removed OpenKnowledge files / move the app to the Trash) so the one remaining action stands out, with the cleanup log as a "reveal in Finder" link instead of a raw path.
