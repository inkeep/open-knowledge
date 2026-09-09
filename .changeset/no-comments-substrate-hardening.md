---
'@inkeep/open-knowledge': patch
---

Internal tooling and repository hygiene, with one adopter-visible behavior change: the
no-comments scope config now refuses to load a hash family whose declared extensions map to
a dialect with no measured lexer reference, instead of silently gating verdicts (and `--write`
strip ranges) on a lexer nothing checks. No configuration in this repo or its mirror trips it
(`no-comments.config.jsonc` declares only `shell` and `yaml`, both referenced), but a fork that
declared a `.py` hash family goes from loading to a hard refusal with no deprecation window.
