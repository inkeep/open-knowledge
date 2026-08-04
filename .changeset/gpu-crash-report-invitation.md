---
"@inkeep/open-knowledge": patch
---

A graphics glitch that fixed itself no longer asks you to file a bug report. Chromium draws each window from a separate process and replaces that process on its own when it dies, restoring the picture in about a second — usually before there is anything to notice. OpenKnowledge was treating every one of those deaths as a crash worth interrupting you over, so the report dialog could arrive moments after nothing visibly happened, leaving you to describe a failure you never saw. One such report was filed for a session that had recovered a full second before the invitation appeared and then ran normally for the rest of its life.

Those deaths are now recorded quietly instead. If the graphics process keeps dying — three times inside five minutes, the point where it is no longer recovering and the window really does degrade — the invitation appears exactly as before. Either way every death is still written to the log, so a report filed for something else still carries the whole picture, and a recovered one says in as many words that it was suppressed and why.
