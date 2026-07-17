---
"@inkeep/open-knowledge": patch
---

Long Ask-AI, Open-with-AI, and Create-with-agent instructions are no longer silently cut to ~1,400-2,200 characters when launched in the docked terminal. The terminal launch previously inherited the web deep-link's URL budget even though it feeds the agent CLI directly through the terminal; it now carries instructions up to ~100 KB, so a long typed prompt reaches Claude, Codex, Cursor, and the other agent CLIs in full. Web deep-link handoffs keep their intentional URL-size budget, and selections continue to travel losslessly on both paths.
