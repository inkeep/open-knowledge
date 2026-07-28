---
"@inkeep/open-knowledge-core": minor
"@inkeep/open-knowledge-server": minor
"@inkeep/open-knowledge-app": minor
"@inkeep/open-knowledge": minor
---

Frontmatter schemas now accept draft-06, 2019-09, and 2020-12 in addition to draft-07.

**Any of four dialects, validated against its own rules.** A schema file declaring `draft-06`, `draft-07`, `2019-09`, or `2020-12` is compiled against that dialect, so `$defs`, `prefixItems`, `dependentRequired`, and the rest behave as their spec says rather than being ignored. Each URI is accepted in `http` or `https` form, with or without the trailing `#`. Previously anything but draft-07 was skipped entirely with a configuration problem telling you to downgrade — a 2020-12 schema, which has been the current dialect since 2020, got you no validation at all.

**An absent `$schema` still means draft-07, and that is still what gets scaffolded.** Creating a schema from Settings ▸ Plugins ▸ Frontmatter schemas writes the draft-07 skeleton as before: it is the most broadly supported dialect among external tools, and the friendly subset the Fields editor writes is spelled identically in all four. Nothing about an existing project changes.

**`format` keeps asserting on every dialect.** From 2019-09 on, the spec demotes `format` to an annotation validators may ignore. OK asserts it everywhere instead, so raising a schema's `$schema` line never silently switches off format checks it already had. This is deliberately stricter than the spec.

**Dialects older than draft-06 are still skipped**, now with a configuration problem that names what is supported instead of demanding draft-07.

**Fixed: editing a schema that declares `$id` silently stopped it validating.** The validator instance outlives any one schema and registers each compiled schema under its `$id`, so recompiling an edited file whose `$id` was unchanged was refused — and because compile failures are swallowed by design, the governed documents just quietly stopped reporting violations until the process restarted. The stale registration is now dropped before recompiling. This bug predates dialect support and affected draft-07 schemas equally, but `$id` alongside `$defs` is idiomatic in 2019-09 and 2020-12, so it would have been far easier to hit.

The no-code Fields editor and the property panel needed no changes: both were already dialect-agnostic, reading only the friendly subset (`type`, `enum`, `items.enum`, `pattern`, `format`, `description`, `required`) and preserving every other keyword verbatim. A 2020-12 schema opens in Fields and round-trips with its `$defs`, `$id`, `unevaluatedProperties`, and `prefixItems` intact — `prefixItems` is not modeled, so it appears in the existing "advanced rules" note alongside `allOf`.
