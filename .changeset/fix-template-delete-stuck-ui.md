---
"@inkeep/open-knowledge": patch
---

Fixed a bug where deleting a template left the app unclickable until reload. The template row's actions menu opened a modal confirmation dialog while itself being a modal menu, stacking two `pointer-events: none` body locks; the post-delete refresh then unmounted the still-open dialog before Radix could unwind the lock, freezing every button (including "New" and "New template"). The menu is now non-modal, matching the file tree and project switcher.
