---
"@inkeep/open-knowledge": patch
---

When the server refuses a document's realtime connection, it now writes a timestamped line to the diagnostic log saying why. Previously those refusals went only to an untimestamped stderr file, so a bug report from a workspace where every document had gone unreachable carried no record of the refusal that caused it and the cause could only be guessed at. The new line names the reason plus the claimed and current value that disagreed, which is what turns that guess into an answer. Nothing about which connections are accepted or refused changed.
