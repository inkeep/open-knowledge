---
"@inkeep/open-knowledge": patch
---

Fix the desktop app's "Open in Antigravity" terminal launch dropping the prompt. `agy` has no positional prompt argument, so `agy '<prompt>'` opened an empty session; the prompt now rides on `agy --prompt-interactive '<prompt>'`, which runs the initial prompt and keeps the interactive session open. Affects every terminal launch that targets Antigravity.
