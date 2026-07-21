---
"@inkeep/open-knowledge": minor
---

Agent thread tabs now get useful titles. The title comes from what you actually typed to start the thread — not the boilerplate lead-in a launch adds — so a tab reads "Fix the login redirect" rather than the shared "You're an agent working inside OpenKnowledge…" preamble every launch opens with. Auto-titles also skip the filler most prompts open with ("please", "can you", "hey, could you take a look at…"), so the words that actually distinguish a conversation land in the tab instead of a shared prefix; when stripping would leave nothing meaningful, the raw prompt line is kept as before (non-English prompts always pass through untouched). Long titles now truncate at a word boundary, and hovering a tab shows the full title.

Tabs are also renamable: double-click a tab to type a new name (Enter commits, Escape cancels). Manual titles stick — they survive archive and server restarts, win over auto-titling, and apply to archived conversations in the history menu too.
