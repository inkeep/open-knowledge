---
'@inkeep/open-knowledge': patch
---

Excalidraw boards now follow the language you have set for the rest of the app. The board's toolbar, menus, and settings, including the stroke Pressure control, were English no matter which language you chose.

Simplified Chinese, Traditional Chinese, Spanish, French, Portuguese (Brazil), Indonesian and Korean all get a translated board, as does Arabic, which the language picker does not list yet. Hindi, Bengali, and Urdu keep an English board, because Excalidraw does not offer a translation for them that it considers complete enough to ship, and a board that is half translated is harder to read than one that is not translated at all. No drawing is affected. One knock-on effect is worth naming: Excalidraw sets the page's language and text direction from whatever board language is active, so on the eight translated languages the page now reports the language you are actually reading, which is what screen readers announce. On the three that stay English it reports English, exactly as it did before.
