---
"@inkeep/open-knowledge": patch
---

Discover git committer identity supplied through included git configs. Auto-save commit identity resolution now reads the effective merged git config (`git config --get`) instead of probing the `--worktree`/`--local`/`--global` scopes one at a time. A scope-limited read only sees values written literally in that one file, so an identity provided via an `include` or `includeIf` directive (for example `gitdir:` or `hasconfig:remote.*.url:` identity switching) was invisible and OK fell back to prompting. The merged read is exactly what git resolves for a commit, so it honors full scope precedence and resolves included configs.
