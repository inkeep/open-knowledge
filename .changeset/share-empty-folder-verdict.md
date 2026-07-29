---
"@inkeep/open-knowledge": patch
---

Sharing a folder with no documents in it now says so plainly instead of promising the link will work after the next sync. Git has no way to represent an empty folder, so the minted link 404s for the recipient and no push would ever fix it — but the share popover offered "Enable auto-sync", "How to push manually" and "Sync now", and running a sync turned the warning into "Synced. The link is up to date." over a link that still went nowhere. The popover now shows a warning naming the only real remedy, adding a document, and offers no sync buttons at all. The `share_link` MCP tool relays the same sentence to agents rather than the push advice, and the freshness signal on `POST /api/share/construct-url` gained an `empty` verdict so the two cases are also tellable apart in the logs. Folders that genuinely just need a push are unaffected, and a doc reports exactly as before at any size, including zero bytes.
