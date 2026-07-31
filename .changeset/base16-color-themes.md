---
"@inkeep/open-knowledge": patch
---

Color themes are now authored in base16, the format the wider theming ecosystem already uses, and they reach considerably more of the app.

The built-in palettes (Dracula, Catppuccin Frappé and Latte, Monokai, Gruvbox, Solarized) are reproduced from their canonical upstream schemes, and Settings → Plugins → Themes gains a "Paste a base16 scheme" field: drop in any of the several hundred published schemes as YAML or JSON — in either the current Tinted Theming layout or the original one — and it applies as-is. The sixteen slots are also editable by hand. An existing custom theme built from the older six-color picker is upgraded automatically rather than reset.

The reason for the format change is coverage. The previous palette used ad-hoc names like "surface" and "accent" that several surfaces had no way to consume, so picking a theme left them on hardcoded colors. base16's slots carry fixed roles that map onto those surfaces directly, and the following now follow the selected theme:

- **Source-mode syntax highlighting.** The CodeMirror editor was pinned to one of two bundled palettes regardless of theme. This also covers the diff view, the text viewer, the text-file editor, and the Mermaid editor.
- **Terminal colors.** All sixteen ANSI slots, so program output is themed, not just the terminal's background.
- **Callouts.** All fifteen accent colors.
- **Fenced code blocks** in the WYSIWYG editor, plus inline code, blockquotes, tables, links, highlight marks, and horizontal rules.
- **Lint squigglies, broken-link underlines, and the file tree's problem indicators.**
- **`html preview` embeds**, which now receive the host's live token values instead of a build-time snapshot of the default theme, so an embed matches the surrounding editor.
- **The desktop window chrome** on Windows and Linux — the titlebar overlay and window background take the active theme's colors rather than staying neutral.

Also fixes three keyframe animations (the sidebar push pulse and two settings flashes) that painted nothing in any theme, including the default one, because they wrapped a color token in `hsl()`.
