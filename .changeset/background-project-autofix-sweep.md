---
"@inkeep/open-knowledge": patch
---

A project-wide **Fix all** now keeps running when you switch away from the Problems tab. Previously the sweep lived inside the Problems panel and ended the moment that panel stopped being rendered, so clicking over to Timeline or Comments mid-sweep left the project partially fixed with nothing to say that anything had stopped, or why. The sweep now belongs to the operation rather than to the panel: it runs to completion in the background, any panel you open mid-sweep picks up its progress, and it reports how it ended — finished, stopped, or failed — wherever you happen to be looking. Completion is now announced too, so a long sweep you walked away from tells you when it is done.
