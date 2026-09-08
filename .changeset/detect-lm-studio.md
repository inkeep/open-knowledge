---
"@inkeep/open-knowledge": patch
---

LM Studio is recognised when you have it installed.

Its row in Agent connections always read "Not detected on this machine", even with the app right there, because OpenKnowledge never actually checked for it. OpenKnowledge asks the operating system which app owns a link type, and LM Studio does register one, so it is now asked about like every other app.
