---
'@inkeep/open-knowledge': patch
---

Turning on a plugin now tells you where to configure it. Enabling a plugin in Settings → Plugins raises a confirmation with an **Open settings** button that jumps straight to that plugin's own page — the page where the plugin actually does something, and which previously you had to know to go looking for in the sidebar.

| Before | After |
| --- | --- |
| Enable Frontmatter schemas, nothing visibly happens | "Frontmatter schemas enabled" with a button to its settings |
| Its settings section appears in the sidebar, possibly scrolled off screen | One click lands you on it |

This applies to every plugin — markdownlint, Frontmatter schemas, and the user-scope Themes plugin — rather than being wired up per plugin. Each plugin's settings page also now carries a **Learn more** link to its documentation, for whoever arrives after the confirmation has gone.
