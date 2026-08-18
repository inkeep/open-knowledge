---
"@inkeep/open-knowledge": patch
---

The desktop app's Move-to-Trash confirmation dialog now shows the actual file name instead of the literal placeholder `{name}`. The bug was an ICU-MessageFormat escape hazard: the source string wrapped the interpolation in single quotes (`'${name}'`), and ICU treats a `'…'`-wrapped section as an escape that renders its contents verbatim — so the compiled message catalog stored one flat string with no interpolation slot and the runtime displayed `Are you sure you want to delete {name}?` to the user. Switched to double-quote wrapping (which matches the rest of the app's convention and has no ICU escape meaning), added a regression guard test, and refreshed all eleven translated locales.
