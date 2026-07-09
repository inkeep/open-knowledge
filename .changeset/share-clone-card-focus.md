---
"@inkeep/open-knowledge": patch
---

Fix the "Open shared folder" dialog showing a heavy, misplaced outline around the
"Clone to a new folder" card when you open a share link. The dialog auto-focuses
that card, and its always-on 2px primary-colored border (with no fill) stacked
with a hard, full-opacity focus ring read as a stray blue outline whose focus
state overflowed the card.

The two choice cards now use the app's standard card treatment: the recommended
clone card gets a subtle 1px primary border with a light primary tint (an
intentional highlight instead of a bare outline), and both cards adopt the
app-wide focus-visible ring, which suppresses the native outline and renders a
soft, contained focus halo consistent with every other control.
