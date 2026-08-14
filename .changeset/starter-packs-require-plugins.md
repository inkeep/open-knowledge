---
"@inkeep/open-knowledge": patch
---

Starter packs can now require a plugin, and seeding one turns it on.

The Open Knowledge Format pack is the first to use this. It now scaffolds a minimal OKF v0.2 bundle: a root `index.md`, one populated `concepts/` folder, one typed guide, and one draft Concept template. It also installs the v0.2 companion skill. The pack leaves optional taxonomies and `log.md` out until the project needs them. Seeding enables the OKF plugin too, which turns "conformant when you made it" into "conformance you can see slipping".

The initialize dialog says so before it happens. A required plugin appears in the plan preview alongside the folders and files it will create, named the way it appears in Settings, with a note that you can turn it off any time. `ok seed` prints the same thing after applying. This matters most in one specific case: if you had previously switched the plugin off and then seed a pack that requires it, it comes back on — and you should not have to go hunting through Settings to work out why. Turning it back off afterward is a single toggle, and nothing re-enables it later.

Your existing configuration is left alone. Enabling a plugin sets one key; other plugins, their settings, and any comments in your `config.yml` survive untouched. Re-seeding a project whose required plugins are already on writes nothing at all.
