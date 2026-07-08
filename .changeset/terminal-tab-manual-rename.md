---
"@inkeep/open-knowledge": minor
---

Add manual rename to terminal tabs. Double-click a terminal tab (or press F2
while it's focused) to give it a name of your own, edited inline. The custom
name pins over whatever title the running program sets via its terminal title
escape sequence — useful for agent CLIs that constantly rewrite their title — so
the tab keeps the name you chose. Press Enter or click away to commit, Escape to
cancel; committing an empty name clears the custom label and restores the
program's title (or the positional "Terminal N" default).
