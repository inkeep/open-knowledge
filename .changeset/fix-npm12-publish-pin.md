---
"@inkeep/open-knowledge": patch
---

Restore npm publishing for the beta channel. npm 12.0.0 ships without the bundled `sigstore` module its publish-with-provenance path requires, which broke the npm uploads for `0.28.1-beta.0` and `0.28.1-beta.1` (their GitHub releases and macOS builds shipped normally). Release CI now pins npm to the 11.x line, and this release carries all changes from the two npm-skipped versions.
