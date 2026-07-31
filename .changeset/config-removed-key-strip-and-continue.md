---
"@inkeep/open-knowledge": minor
---

A config key that was removed in a newer version no longer discards the rest of the file it appears in.

Config files accumulate keys that later releases retire. Until now, a single retired key anywhere in a file — your committed `.ok/config.yml`, your user-global `~/.ok/global.yml`, or the per-machine `.ok/local/config.yml` — invalidated the **whole** file: every unrelated setting in it silently reverted to its default. A long-dead cosmetic setting left behind in a config could therefore switch off something you actively depend on, with nothing reporting a failure. In one case a retired sidebar preference sitting in a project-local config threw away an explicit `autoSync.mode: full`, so Git sync stopped running and stayed off.

Now every config layer strips only the retired keys it finds, keeps every other setting at the value you wrote on disk, and reports each stripped key together with what replaced it. Genuinely broken files are unaffected by this change: invalid YAML and settings that fail validation are still rejected exactly as before. Only the handling of retired keys changed.

- **`ok start` no longer fails to start over a retired key in your committed `.ok/config.yml`.** It strips the dead key, prints what it found and the replacement guidance, and starts. Previously one stale key could stop the tool from starting at all.
- **`ok config migrate` can now reach your per-machine config.** It defaults to every layer, so the bare `ok config migrate` each error message tells you to run now fixes the key wherever it lives. A new `--scope project-local` targets `.ok/local/config.yml` alone, `--scope all` is the explicit form of the new default, `--scope both` keeps its old project-plus-user reach, and `--dry-run` still previews without writing. Migration only ever removes a retired key and reports its replacement — it never rewrites your other files on your behalf (for example, it will not create or edit `.okignore` for a removed `content.include`, because that rewrite is not a faithful one-to-one translation).
- **`ok config validate` now reports all three config layers.** It previously described only your user-global and committed-project files, so a retired key in the per-machine `.ok/local/config.yml` — the layer the reported bug lived in — got an unqualified `✓`. It now reads that layer too, so a stale key is findable without a running server. Reporting is read-only: an unreadable layer is described, never moved aside.
- **New endpoint `GET /api/config/diagnostics`** lists the retired keys currently present across your user, committed-project, and project-local configs, each identified by its scope, file, key path, and replacement guidance. It reads the files fresh on every request, so fixing a file is reflected on the next request without a restart, and it never returns your actual config values.

**Settings that a retired key was suppressing now take effect.** Some features deliberately fall back to a safe value when a config file cannot be trusted, and until now a retired key made a file untrusted. Those features therefore ignored what you had written in the same file. Now that a retired key leaves the file readable, your settings in it apply — which for an affected config is a real change in behavior, in both directions:

- **External link previews.** A project-local config carrying a retired key had link previews forced off, even when you had explicitly enabled them. Your explicit setting is now honored. If that file has no `linkPreviews` setting at all, the default (previews on) now applies, and hovering an external link sends its URL to the destination site where previously it did not.
- **Semantic search.** A `search.semantic` block sitting alongside a retired key was discarded, leaving semantic search off. Your configured provider and model now apply, and enabling semantic search sends content to that provider.
- **Editor bridge safeguards.** An explicit `bridge.*` opt-out alongside a retired key was overridden back on. Your opt-out now takes effect.

If you rely on any of these being off, check the config file the diagnostics endpoint or `ok config validate` reports a retired key in. A file that is genuinely unreadable (invalid YAML, or settings that fail validation) still falls back to the safe value exactly as before.
