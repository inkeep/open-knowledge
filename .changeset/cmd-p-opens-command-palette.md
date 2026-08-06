---
'@inkeep/open-knowledge': patch
---

Open the command palette with `Cmd+P` / `Ctrl+P`, in addition to `Cmd+K`.

`Cmd+K` is dual-role — with text selected in the visual editor it adds a link instead of
opening the palette — which meant that in exactly that state there was no keyboard route to
the palette at all. `Cmd+P` is unconditional: it opens the palette from anywhere, including
mid-selection, so the palette is always one chord away.

It is also the chord most editors use to find a file, so it should do roughly what you expect
if you arrive from one. On the web this now opens the palette rather than the browser's print
dialog; printing is still available from the browser's own menu.
