---
'@inkeep/open-knowledge': patch
---

Hide OpenKnowledge's own built-in skills from the fullscreen graph, and add a control for the rest.

The link index treats skill bundles as graph nodes on purpose, but a global skill can never link to a document — the index registers it node-only and resolves its refs same-scope. OK force-installs two of its own bundles into every project, so every graph carried four nodes that were structurally incapable of connecting to anything in it.

Those bundles are now excluded from the fullscreen graph unless another skill links them directly by name. A new toggle beside the external-URL control governs your own skills, project and global, and shows them by default. The docked local graph is unchanged: it still shows every skill node, so a skill's own neighborhood stays inspectable there.
