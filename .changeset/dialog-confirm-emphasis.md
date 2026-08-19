---
"@inkeep/open-knowledge": patch
---

Confirmation dialogs no longer make their confirm button look like the least important control in the footer. Two of them, the "Maintain generated indexes in every folder?" prompt in Settings and the skill plugin bundle install prompt, drew Cancel as a bordered button and the confirm as flat text with no fill or border, so the escape action read as the primary one. Both confirms now use the standard primary button, the same shape the app's other non-destructive confirmation dialogs already use.

The light theme's primary blue is also slightly deeper. At its previous lightness it fell below the WCAG 2 AA contrast floor both as a button fill under white label text and as the text of a link-styled button. The new value clears 4.5:1 on both while keeping the same hue and saturation.

Document links in the light theme are a deeper blue now too. That is a separate token from the primary, and it was reading at 3.56:1 on the page background, so ordinary links inside a document sat below the same floor. It now clears 5.2:1. The palette entry it used to point at is unchanged, because that entry also drives icon fills and text selection, where no text contrast requirement applies.

Catppuccin Latte and Solarized get the same treatment. Both took their blue straight from the upstream palette, and in both cases that blue missed the same 4.5:1 floor, at 4.35:1 for Latte and 4.08:1 for Solarized. Latte's is now a little darker and Solarized's a little lighter, each clearing 4.63:1. Because these themes derive their whole blue from one palette entry, the change also lifts link text, note callouts, and the sidebar accent in those two themes above the floor.
