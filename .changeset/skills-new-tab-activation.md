---
"@inkeep/open-knowledge": patch
---

Clicking a second empty tab in the Skills editor now switches to it. Every empty Skills tab shares one route (the Skills home), so re-resolving that route while you already had one open snapped you back to the leftmost empty tab. Activation looked frozen: clicking another empty tab did nothing, the + button appeared to open a tab it never took you to, and Cmd-2 wouldn't move either. Empty Files tabs were unaffected. The Skills home now keeps whichever of its tabs is already active instead of always picking the first.
