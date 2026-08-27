---
"@inkeep/open-knowledge": patch
---

Document names are now replaced with a short fingerprint in the basic bug report. The app's diagnostics gained a record of scrolling and outline clicks, which is what makes a "the page jumped" report diagnosable at all, but each of those records named the document it happened in, and several routine log lines already did the same. That turned a report from an ordinary session into a readable list of the files you had open, sent under a notice that mentions logs and system info and says nothing about documents. The support team can still tell which records belong to the same document and follow what happened in it; they no longer receive the list of names. Detailed diagnostics, which you opt into separately and which does say it includes document names, is unchanged.

To be straight about how strong this is: the fingerprint is not reversible in bulk, but it is not a secret either. Someone who already suspects a specific filename can check that guess against a fingerprint. It removes the list, not the possibility of confirming a name someone has reason to try.
