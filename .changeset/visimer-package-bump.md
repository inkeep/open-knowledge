---
"@inkeep/open-knowledge": patch
---

Mermaid WYSIWYG rendering now depends on `@visimer/{core,dom}@0.1.0` instead of `@inkeep/mermaid-wysiwyg-{core,dom}@0.1.0`. The upstream project moved to a scoped package name; the published dist ships the fixes we previously patched in tree, so the local patch is dropped.
