---
"@inkeep/open-knowledge": patch
---

The published TypeScript declarations (`dist/index.d.mts`) are now bundled from the declarations that `@inkeep/open-knowledge-core` and `@inkeep/open-knowledge-server` emit for themselves, rather than re-emitted from those packages' sources inside the CLI's own build.

Nothing about the declared API changes: the file exports the same 107 symbols, keeps the same `any` and `unknown` counts, and stays self-contained with no imports from sibling `@inkeep/*` packages. The only consumer-visible difference is three additional import statements for Node built-ins (`node:fs`, `node:fs/promises`, `node:stream`) that no exported type references. The published tarball still excludes `dist/**/*.map`.

The published file is now type-checked as a standalone declaration file on every run of the repo's check lane, and the same check compares its exported-symbol set, its `any`/`unknown` counts and its freedom from `@inkeep/*` specifiers against the captured 5.9.3 baseline. A dropped export, a sibling type that degraded to `any`, or an unresolvable sibling import fails the build instead of shipping.
