---
"@inkeep/open-knowledge": patch
---

Pull the latest changes without leaving OpenKnowledge when a share link arrives ahead of your copy.

When someone sends a link to a doc that is already on GitHub but has not reached your local copy yet, the receive dialog used to say "pull the latest changes, then open the link again" and leave you to go do it in a terminal. It now offers "Pull latest changes" on the spot: OpenKnowledge fetches and fast-forwards your copy in place, then opens the shared doc once the update lands. It only ever pulls — nothing is committed or pushed on your behalf, and your uncommitted edits ride on top of what comes in. If the pull can't run, because another sync operation is already in flight or GitHub is unreachable, the reason appears under the message and the button stays available to retry.

When that pull lands on a project whose sync is off, OpenKnowledge then asks whether to keep the copy updated, so later links arrive on a copy that is already current. It is the usual Follow confirmation, asked once the pull has proved its worth rather than offered as a second button beside it: confirm and Follow turns on before the shared doc opens, decline and the doc opens anyway. You are asked at most once per session, and never after a pull that failed or brought a conflict with it.

The button and the question both appear in the dialog you get before a tab opens and in the in-tab panel behind it, and both stand down in favor of the previous guidance when the project has no GitHub remote or its sync is mid-conflict.
