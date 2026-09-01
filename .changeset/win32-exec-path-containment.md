---
"@inkeep/open-knowledge": patch
---

Path containment holds on Windows.

The check that keeps agent tools inside the project root compared the resolved relative path against a literal `../` prefix. On Windows the separator is a backslash, so a traversal written as `..\` was not recognised and the path was treated as contained.

`exec` does sandbox its shell to a root, but that root is whatever the `cwd` argument resolved to. When the `cwd` itself escaped, the sandbox was faithfully rooted at the escaped directory and had nothing left to catch. That asymmetry is what made this reachable.

Separators are now normalised before the check. Absolute paths, other drives, and UNC shares were already refused and still are. Windows was the only platform at risk, though one behaviour changes everywhere: a file whose name literally begins with `..\` is now refused as well.
