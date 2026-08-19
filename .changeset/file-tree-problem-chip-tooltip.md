---
"@inkeep/open-knowledge": patch
---

The number next to a file name in the sidebar now explains itself on hover. The chip counts the validation problems in that file, and the red or yellow tint on the name is the worst severity among them, but nothing said so anywhere in the interface. The explanation existed already and was reaching screen readers as the chip's accessible name, while a sighted reader hovering the chip got either nothing or the file's full path. Two things stood in the way: the chip declined pointer events, so the cursor fell through to the row underneath, and the row carries the full path as its own tooltip, which a descendant only escapes by carrying a tooltip of its own. The chip now does both, so hovering it reads something like "2 errors and 1 warning in this file. Open the Problems panel for details." The text is translated into every supported language.
