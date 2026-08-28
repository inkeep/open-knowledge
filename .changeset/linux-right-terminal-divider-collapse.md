---
"@inkeep/open-knowledge": patch
---

Fixed dragging the divider of a right-docked Terminal on Linux, which closed the column instead of resizing it. The workaround of using the bottom dock is no longer needed.

The resize library treated any pointer event that left the window mid-drag as a full-width jump rather than as the distance the pointer had actually travelled, and a column that can be dragged shut reads a full-width jump as "shut". Electron 43 was the version that started emitting such an event on Linux, but the misreading was there all along, so the fix is to measure the drag from where it started no matter what interrupts it.
