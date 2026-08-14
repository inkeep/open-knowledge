---
"@inkeep/open-knowledge": patch
---

OpenKnowledge Desktop on Windows now detects MSIX-installed agent apps — including Claude's current Windows distribution and the ChatGPT (Codex) Store app. MSIX packages register their `claude://` / `codex://` link handler at install time but in a way Electron's protocol query can't see (it looks for a classic executable association, which MSIX never writes), so the "External apps" picker wrongly treated those apps as not installed even though the browser-mode picker on the same machine saw them. The desktop app now falls back to the same registry check the server uses, so both hosts agree.
