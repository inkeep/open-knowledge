---
"@inkeep/open-knowledge": patch
---

Creating a folder from the sidebar, or renaming one while you have it open, no longer closes its tab and drops you back on the empty workspace screen. A folder tab was kept only while its folder appeared in the server's folder listing, and an empty folder does not reach that listing until the server has caught up. A background refresh landing inside that window closed the folder you had just navigated into, and because a freshly created folder is usually the only thing open, the workspace was left with nothing and fell back to the onboarding view. The folder you are currently viewing is now held open through that window, matching the protection documents already had, whether you reached it from the sidebar or from a wiki link. Folder tabs you have navigated away from are still tidied up as before, and deleting a folder yourself still closes its tab straight away.

One behavior worth knowing, because it is new: a folder deleted outside the app, by an agent or another client, keeps its tab open for as long as you are viewing that folder.
