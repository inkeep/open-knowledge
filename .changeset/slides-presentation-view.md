---
"@inkeep/open-knowledge": minor
---

A markdown document can now be opened as a slide deck in its own OpenKnowledge window, via a new **Slidev** plugin (beta). Rendering is handled by [Slidev](https://sli.dev/), which OpenKnowledge neither renders itself nor downloads or bundles — so install it first: `npm install -g @slidev/cli @slidev/theme-default` (global), or add those packages to the project (a project-local install takes precedence). Slidev themes ship as separate packages from the CLI, and a deck cannot open without the theme it declares — `@slidev/theme-default` covers decks that use the default theme or declare none.

Then turn on the Slidev plugin in **Settings → Plugins**, add `slides: true` to a document's frontmatter, and an **Open in Slidev** action appears in the editor toolbar; activating it opens the deck in a dedicated window you can present from. Editing the document in OpenKnowledge updates the open deck, because Slidev watches the file OpenKnowledge is already saving to.

The plugin's own settings page reports whether OpenKnowledge found Slidev, and offers the install command to copy or to run in a terminal when it did not. When no `slidev` resolves, the toolbar action is simply absent rather than failing on click. Closing a deck window stops that deck's process, and quitting the app stops all of them. The plugin is off by default, desktop only, and adds nothing to the app bundle for anyone who does not enable it.

Docs: [Plugins → Slidev](https://openknowledge.ai/docs/plugins/slidev).
