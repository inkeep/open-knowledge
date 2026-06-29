---
"@inkeep/open-knowledge": patch
---

Desktop: enable the openknowledge.ai update proxy for the stable (`latest`) channel too. Stable builds now fetch updates through `openknowledge.ai/updates/stable`, which 302s to the byte-identical GitHub asset (preserving the manifest sha512 and the macOS signature) so stable updates are counted per version. This follows the verified end-to-end beta update (beta.13 to beta.14) through the proxy. The stable path resolves via GitHub's authoritative `releases/latest` alias, and a feed failure still reverts to the GitHub provider for the session, so auto-update reliability never drops below GitHub-direct.
