---
"@inkeep/open-knowledge": patch
---

The editor header no longer lets its trailing actions cover the file-navigator toggle at narrow widths.

The header lays out a leading rail (the Files toggle) and a trailing rail (Share, sync status, presence, Settings, Resources) as two overlays that measured each other but never negotiated for width. At a phone-width window with the file navigator open the header is about 97 px wide, the trailing rail kept its full width, and it spilled left over the toggle: tapping the toggle activated Settings instead, and two trailing buttons landed over the navigator and could not be tapped at all.

The header now compares the trailing rail's own width against the space the leading rail leaves it. When they do not both fit, the trailing actions collapse into a single **More actions** button that opens them in a popover; every action keeps its label and behaviour. Where both rails already fit, which is every desktop width, nothing changes.

Sync connection toasts no longer depend on the header's layout. They were hosted inside the presence avatars, so they are now raised into a dedicated host that stays mounted whatever the header does.

The **More actions** button also carries the sync state it hides. When git sync is in conflict, offline, needs reauthentication, or is paused, the button shows a coloured dot and names that state in its accessible label, so a collapsed header never hides a sync problem.

When the header gets narrower still and cannot seat the leading rail, the trailing button and the document tab strip at the same time, the tab strip now hides instead of drawing a clipped sliver underneath the buttons.
