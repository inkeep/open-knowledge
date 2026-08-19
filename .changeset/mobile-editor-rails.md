---
"@inkeep/open-knowledge": patch
---

Reading and prompting in the editor now work on a phone. On touch devices under 640px wide, the side rails that frame the document shrink from 4rem to 1rem, so text gets the width it needs instead of wrapping every few words. The floating Ask AI composer benefits most: it sits in the same content column, and on a 393px-wide screen its input had been squeezed to 9px — too narrow to show a placeholder, let alone type into. It now gets a real text field.

This is scoped to touch devices on purpose; a narrow desktop window keeps the wider rails, where the hover-revealed block drag handle still needs the room. Other surfaces remain desktop-shaped at that size: the Outline, Links, Graph, Timeline, Problems and Comments panel cannot be opened on a phone, and the file tree takes most of the screen when shown rather than overlaying the document.
