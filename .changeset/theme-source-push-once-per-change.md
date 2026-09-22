---
"@inkeep/open-knowledge": patch
---

A desktop window now sends its theme preference to the native appearance once per change, instead of re-sending it whenever the colour palette or the config connection settles. When one window's appearance is changed by another, switch the affected window's own theme preference and back to restore it.
