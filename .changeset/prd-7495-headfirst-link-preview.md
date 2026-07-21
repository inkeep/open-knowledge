---
"@inkeep/open-knowledge": patch
---

Link previews now load for content-heavy pages like GitHub and Wikipedia: the fetcher streams to the end of <head> instead of rejecting once the page body exceeds the 512 KB cap.
