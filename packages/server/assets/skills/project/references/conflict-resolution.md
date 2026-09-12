# Conflict-aware writes

Documents can be frozen by either a Git merge conflict or a `stale-external-write` conflict, even with GitHub sync disabled. A stale external write means the file was restored to the exact older version that OpenKnowledge had replaced with a newer acknowledged edit. This may be a stale editor save or an intentional revert. The protected content remains in Yjs and a local recovery snapshot while the disk file is frozen for resolution. The MCP server refuses every mutating call against either kind of conflicted doc with a structured RFC 9457 response:

```json
{
  "type": "urn:ok:error:doc-in-conflict",
  "title": "Document is in conflict.",
  "status": 409,
  "detail": "The document is frozen by a Git or stale external-write conflict. Call conflicts({ kind: \"list\" }) to identify the kind, then conflicts({ kind: \"content\" }) + resolve_conflict before retrying.",
  "file": "notes/sso.md",
  "resolutionOptions": ["mine", "theirs", "content", "delete"]
}
```

The gate covers `write`, `edit`, `delete`, `move`, `restore_version`, and agent undo on the document write spine, including live template writes. You cannot route around it by writing content that byte-matches one of the merge stages — the gate refuses on lifecycle state, not on body equality.

A write that first detects the stale file during its final disk flush instead returns `urn:ok:error:stale-external-write` (409). This is a partial outcome: the edit reached collaborative state and the local recovery snapshot, but the disk write was skipped. Inspect the conflict, resolve it, and re-read the document before deciding whether to repeat the original operation. Blindly retrying an append can duplicate content already retained in `ours`.

While such a pending edit is retained, further external saves do not discard it or automatically clear the conflict. Re-read the conflict before resolving: `theirs` can reflect a subsequent disk save while `ours` still preserves the pending edit.

**Detect proactively.** `exec("cat <path>.md")` always returns `lifecycle: {status, reason} | null` alongside the body. When `status === 'conflict'`, switch to the resolution flow before attempting any mutation.

**Resolution flow.** Three tools compose:

1. `conflicts({ kind: 'list' })` → enumerate every doc currently tracked in conflict. Each entry includes `conflictKind: 'git' | 'stale-external-write'`, and Git working-tree overlays also carry `variant: 'working-tree'`. The content response's `conflictKind: "git"` covers both Git-index conflicts and working-tree overlays; inspect the list entry to distinguish them, because the resolution mechanics below differ.
2. `conflicts({ kind: 'content', file })` → returns `{ content: { base, ours, theirs, shape, lifecycleStatus, conflictKind } }` (the result nests under the `content` kind key). For Git conflicts, `ours` reflects the live Y.Text when loaded and marker-free, falling back to `git show :2:<file>` otherwise. For stale external writes, `ours` is the protected content, recovered from the local snapshot when unloaded, and `theirs` is the rejected older save. An intentional exact revert can trigger the same protection; choose `theirs` to confirm that revert.
3. `resolve_conflict({ file, strategy, content? })` → write the chosen bytes. For Git-index conflicts, `mine` runs `git checkout --ours`, `theirs` runs `git checkout --theirs`, `content` writes the bytes you supply, and `delete` runs `git rm`; each stages the result and commits after the final tracked conflict clears. For Git working-tree overlays, `mine` keeps the working-tree file, `theirs` restores the pinned incoming blob, `content` writes the bytes you supply, and `delete` removes the file; nothing is staged and no resolution commit is created. For stale external writes, `mine` keeps the acknowledged Yjs content, `theirs` accepts the rejected disk version, `content` writes the bytes you supply, and `delete` removes the document; these local resolutions do not create a Git commit. For every kind, `content` accepts an explicit empty string, which keeps an empty file; omitting `content` is invalid.

`file` is a `.md` / `.mdx` path relative to the project dir (extension included) — mirrors the on-disk shape, not the extension-less `document` path used by other tools.

The resolve operation is best-effort and NOT atomic across disk, collaborative state, and indexes. A failed local resolution retains its recovery record for retry; re-read the conflict before retrying. For Git-index conflicts, `git checkout --ours/--theirs && git add` may succeed but the subsequent `git commit --no-edit` can fail (pre-commit hook rejection, locked index). On commit failure the file stays staged in git's index — the resolution itself is not undone — but the tracked entry is re-added to `conflicts.json`, so the write gate keeps refusing mutations against it; re-call `resolve_conflict` after the user clears the blocker. A working-tree overlay resolution attempts no commit; if it fails, its entry is added back to `conflicts.json` and can be retried directly.

Local recovery data lives in `.ok/local/stale-external-writes.json`, with owner-only file permissions. If the server reports that snapshot as corrupt, unreadable, or incompatible, do not delete it or restart with empty state: it may hold the only copy of protected edits. Preserve the file, restore a known-good backup, and run `ok bug-report` from the project directory to collect diagnostics without starting the server; seek support if its edits need recovery. An unresolved conflict does not expire with the 30-minute displaced-hash window.
