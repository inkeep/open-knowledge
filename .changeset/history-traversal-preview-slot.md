---
'@inkeep/open-knowledge': patch
---

Back and Forward no longer pile up tabs. With preview tabs on, single-clicking through several files in the sidebar keeps the strip at one tab, but pressing Back then added a permanent tab for each earlier file, so a few presses turned one tab into a strip you had to close by hand. History navigation now reuses the same preview slot the sidebar click used, so going back through a run of previews leaves you with one tab, italic, on whichever file you landed on. With preview tabs turned off, Back and Forward behave exactly as before and open permanent tabs.
