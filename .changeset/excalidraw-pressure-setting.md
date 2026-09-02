---
'@inkeep/open-knowledge': patch
---

Excalidraw boards gain the stroke Pressure setting. The properties panel now offers Constant and Variable pressure for freehand strokes.

Freehand strokes you draw from now on are half the width they used to be at the same setting. Upstream halved the width scale for freehand strokes specifically, and it applies whichever Pressure setting you use. Picking the bold width restores the previous default exactly.

New strokes also default to Constant, an even line that holds one width end to end, and it is narrower again because the renderer that draws it scales differently from the one that tapers. The first time you draw with a pen, Variable is selected instead: there the width follows how hard you press, which is how freehand strokes have always been drawn here, though a pen stroke now tracks your hand a little more closely than it used to. Switch between them in the properties panel. Strokes already on your boards keep the width and the look they have.

The first time you open each board, its file is rewritten once to pick up the new format fields. Your drawings are unchanged by that rewrite. If your content directory is tracked in git, expect each board to appear as modified as you open it; boards you have not opened stay untouched, and a board that has been rewritten is stable from then on.

Sharing a board is safe. Excalidraw builds older than this upstream change do not know the Constant setting, so a stroke set to Constant draws with their variable-width renderer, and the VS Code extension and older Open Knowledge builds are the ones you are most likely to meet. They do not discard the setting: reopen the board here and the stroke is Constant again. Builds that already track the change, excalidraw.com and the Obsidian plugin among them, draw it as Constant.
