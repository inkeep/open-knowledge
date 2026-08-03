---
"@inkeep/open-knowledge": patch
---

You can now pick one color theme for light mode and a different one for dark mode. Every tile in **Settings → Plugins → Themes** carries a sun and a moon: press the sun to make that palette your light theme, the moon to make it your dark theme, or both to use it either way. Whichever mode you're in — including when your theme setting is **System** and your OS decides — the matching palette applies, and it swaps as the appearance changes without touching your config.

Any palette can sit in either slot; it still forces its own light/dark variant, so choosing a dark scheme as your light-mode theme does what it says. Existing setups are unchanged: a single palette chosen before this release applies to both modes until you pick a new one.

Switching themes is also faster than it was. Repainting the terminal palette used to re-measure each color separately against styles the switch had just invalidated, which stalled the window for a moment on every change; the whole palette is now measured in one pass and refreshed once per frame.
