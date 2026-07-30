---
'@inkeep/open-knowledge': patch
---

Show agent icons in dark mode instead of near-invisible black marks.

Most of the agents in the catalog rendered as a black smudge on a dark
background: Devin, DeepAgents, Factory Droid, Cortex Code, Dirac, fast-agent and
every other agent whose icon comes from the ACP registry. Only Claude, Codex and
Cursor looked right, because those three are the ones the app draws itself.

The registry requires every icon to be a monochrome SVG painted with
`currentColor`, so it can take the color of whatever surface it sits on. Loading
one through an `<img>` tag defeats that: the SVG becomes its own document, and
`currentColor` there falls back to black no matter what the app's theme is. The
icons now lift to white on dark themes. Light themes are unchanged.

This covers every place these icons appear, not just the settings list: the
agent launcher menus, the composer, the terminal's new-chat picker, thread
history, and the thread empty state.

The bug report dialog also got a pass. It is wider, its "Previous reports"
disclosure has room around the label on hover rather than a background flush
against the text, and expanding it no longer leaves that background stuck on
while the list is open.
