---
"@inkeep/open-knowledge": patch
---

Desktop apps you already have installed now show up in the agent pickers automatically. Claude, Codex, and Cursor were previously hidden until you opted each one in under Settings → Configure agents; OpenKnowledge now detects them per platform (LaunchServices on macOS, the registered protocol handler on Windows, `xdg-mime` on Linux) and lists them without any setup. The Settings toggles still win in both directions — turn one off to hide it, or turn on an app you haven't installed yet to get its download page.

The section is now called "External apps" and each row reads "Claude Desktop" / "ChatGPT Desktop" / "Cursor Desktop" (the Codex desktop app is branded ChatGPT since OpenAI folded the two together), so it is no longer confusable with the same-named Terminal CLI row above it. When an external app is the selected target, the composer's button says "Open Claude Desktop" with an external-action arrow, since that click leaves OpenKnowledge; in-app agents and terminal CLIs now consistently read "Ask <name>".
