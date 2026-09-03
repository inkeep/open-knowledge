---
'@inkeep/open-knowledge': patch
---

Dialog buttons no longer mix typefaces. About half the dialogs in the app drew their dismiss button in the regular UI face while the confirm button beside it was monospace and uppercase, so a single row of buttons read as two different type systems. Every dialog footer now draws its buttons the same way, whichever button it is.

Nothing moves and no wording changes. The dialogs that already looked right are untouched; the ones that did not now match them.
