---
"@inkeep/open-knowledge": patch
---

Fixed a folder whose name contains a space being impossible to collapse in the sidebar. Clicking such a folder would expand it and open its page, but every click after that did nothing — the row stayed open for as long as the project did. The tree steps aside and lets a click toggle the row only once the URL already points at that folder, and it decided that by comparing the address bar's hash against a freshly built one. The browser writes a space as `%20`, the built one kept the literal space, so for those folders the two never matched and the click was consumed every time. Names with accented or other non-ASCII characters were affected the same way. The same mismatched comparison also made the back button need a second press on those documents, and could leave the previously active tab unrestored on launch.
