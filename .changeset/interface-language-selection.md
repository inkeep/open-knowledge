---
"@inkeep/open-knowledge": minor
---

OpenKnowledge now speaks your language. On first launch it follows the language your operating system is set to, and **Settings → Appearance → Language** lets you choose a different one at any time. The switch is immediate — the interface, the native File/Edit/View menus, and the app's dialogs all change while you keep working, with nothing to restart and nothing to reload.

Eleven catalogs ship: English, Simplified and Traditional Chinese, Spanish, Hindi, French, Arabic, Bengali, Brazilian Portuguese, Indonesian, and Urdu. Three are offered in the picker today — English, Español and 简体中文 — because a language appears there once someone who reads it has reviewed it. The rest are complete and reachable by name, so a translator can run the app in the language they are checking; Arabic and Urdu stay reachable but unlisted until right-to-left layout lands.

Detection is script-aware rather than a language-code match, so a Traditional Chinese system in Taipei gets Traditional rather than Simplified, and `es-MX` gets Spanish rather than falling back to English. Choosing **System** keeps following your OS from then on, including if you change it later — the choice is stored as "system" rather than as whichever language that happened to mean the day you picked it.

Your own writing is never touched. Document text, titles, file and folder names, frontmatter, tags and link targets stay exactly as you wrote them, in whatever language you wrote them in; only the application's own chrome changes.

For anyone adding UI copy: strings are extracted and translated in the same change, and a lint rule now fails the build on a new hardcoded user-facing string, so a missing translation is caught before it ships rather than discovered in the interface.
