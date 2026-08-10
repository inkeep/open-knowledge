---
"@inkeep/open-knowledge": patch
---

The agent-thread composer now uses the same rich prompt field as every other AI composer in the app. Typing `@` in the sidebar chat picks files, folders, and assets from the workspace and inserts them as removable chips, exactly as it does in the bottom Ask AI, New Tab, and comment composers — the agent receives them as `@path` references it can open. The migration also fixes a live input bug: the thread composer had no IME-composition guard, so committing CJK text with Enter could fire a premature send; the shared field guards every surface uniformly. Composer drafts still behave the same — staged selection passages append to what you typed, and stopping a turn folds its queued messages back into the field. With all four prompt surfaces on one component, upcoming composer capabilities (attachments, slash commands) land once and reach every surface.
