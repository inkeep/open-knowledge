# Conflict-aware writes

A doc can land in conflict through a Git merge, a pull that collides with a local overlay, or OK's own reconciliation of the editor against disk. Reconciliation also protects an acknowledged edit when another app restores the exact older file version; that `stale-external-write` path works with GitHub sync disabled. `ConflictAuthority` tracks every kind, and the MCP server refuses a mutating call against a conflicted doc with a structured RFC 9457 response:

```json
{
  "type": "urn:ok:error:doc-in-conflict",
  "title": "Document is in conflict.",
  "status": 409,
  "detail": "The document is in a conflict state. Call conflicts({ kind: \"content\" }) + resolve_conflict before retrying.",
  "file": "notes/sso.md",
  "conflict": { "kind": "reconcile", "reason": "disk-markers" },
  "resolutionOptions": ["mine", "content", "delete"]
}
```

The gate covers `write`, `edit`, `delete`, `move`, `restore_version`, and agent undo (the doc-CRDT write spine; template/folder ops are fs-direct). You cannot route around it by writing content that byte-matches one of the stages. The gate refuses on tracked state, not on body equality.

A write that first detects a stale file during its final disk flush returns `urn:ok:error:stale-external-write` (409). The edit reached collaborative state and the recovery snapshot, but the disk write did not happen. Resolve and re-read before deciding whether to repeat the operation; a retried append can duplicate content already retained in `ours`.

**Detect proactively.** Call `conflicts({ kind: 'list' })` before a batch of writes. An `exec` read carries no conflict flag, so the only other signal is the 409 above, which arrives after a write has already been refused.

## The three kinds

| `conflict.kind` | Where it comes from | What a resolve does |
| - | - | - |
| `merge-native` | a git merge left unmerged stages in the index | stages your choice with git, and commits the merge once no `merge-native` conflict is left (other kinds do not hold the commit back) |
| `working-tree` | a pull-only overlay collision, pinned to the origin blob it collided with | writes the chosen bytes to disk; nothing is committed |
| `reconcile` | OK's own three-way merge of the editor against disk, including stale external saves. No git object holds the stages, so OK snapshots them at detection | writes the chosen bytes to disk and into the loaded document; no git command runs |

A `reconcile` conflict carries a `reason`: `merged-with-markers` (the three-way merge produced markers), `refused-conflict-markers` (the disk bytes already carried markers), `refused-too-large` (the document is past the merge size cap), `disk-markers` (markers landed on disk under an open doc), or `stale-external-write` (an older displaced version returned on disk). The compatibility `conflictKind` field is `stale-external-write` for that last reason and `git` otherwise.

## Resolution flow

1. `conflicts({ kind: 'list' })` → every tracked conflict as `{ file, detectedAt, conflict, reason?, conflictKind?, docName }`.
2. `conflicts({ kind: 'content', file })` → `{ content: { file, base, ours, theirs, shape, conflict, reason?, conflictKind?, resolutionOptions } }` (the result nests under the `content` kind key). `ours` reflects the live Y.Text when the doc is loaded and marker-free; otherwise it falls back to the pinned stage. For a stale external write, `ours` is the protected content and `theirs` is the rejected older save. On a `reconcile` conflict, `mine` uses the latest marker-free live Y.Text, falling back to the captured editor stage when the document is unloaded or contains markers. Send the reviewed bytes back as `content` when you mean to keep exactly what you were shown. Returns 404 `urn:ok:error:no-conflict-tracked` (title `No conflict is tracked for this path.`) when nothing is tracked for that path; re-read the list before retrying.
3. `resolve_conflict({ file, strategy, content? })` → write the chosen bytes. **Send a strategy from that conflict's `resolutionOptions`**, not the full set. A `reconcile` conflict whose `theirs` side is raw marker text does not offer `theirs`, and `refused-too-large` offers only `mine`, `theirs`, and `delete`. An unoffered strategy returns a 422 with `refusal: "strategy-not-offered"`. Markers left in the content you submit return the same status with `refusal: "markers-in-content"`, and that field is what tells the two apart. A 404 (`urn:ok:error:no-conflict-tracked`) carries this detail verbatim: `This file has no tracked conflict — it may have been resolved by another session, or the path may be stale. Re-read conflicts({ kind: "list" }) before retrying.` It says nothing is tracked, not that your resolution was saved, so re-read the list.

Per kind, `mine` / `theirs` mean different things. On `merge-native` they are `git checkout --ours` / `--theirs` (the committed stages 2 and 3), and `delete` is `git rm`. On `working-tree`, `mine` keeps your overlay verbatim and `theirs` restores the pinned origin blob. On `reconcile`, `mine` uses the latest marker-free live Y.Text, falling back to the captured editor stage when the document is unloaded or contains markers; `theirs` uses the disk bytes captured at detection. For a stale external write, these choices keep the current local content or accept the rejected save. `content` always writes the bytes you supply, including an explicit empty string, and `delete` removes the file.

`file` is a `.md` / `.mdx` path relative to the project dir (extension included) — mirrors the on-disk shape, not the extension-less `document` path used by other tools.

Resolution is best-effort across disk, collaborative state, and indexes. A failed local resolution keeps its authority row and recovery snapshot for retry. For `merge-native`, `git checkout --ours/--theirs && git add` may succeed before `git commit --no-edit` fails; the ledger keeps the still-unmerged files. Re-read the conflict before retrying.

A conflict can also close without you. Resolving a merge with raw git outside the app prunes the `merge-native` entry on the next disk change or HEAD move, and a `reconcile` conflict whose file comes back clean on disk dissolves on the next watcher pass.

Stale-save recovery data lives in `.ok/local/stale-external-writes.json`, with owner-only permissions. Do not delete that file or restart with empty state when it is corrupt or unreadable; it may hold the only copy of protected edits. Preserve it, restore a known-good backup, and run `ok bug-report` from the project directory for diagnostics. An unresolved conflict does not expire with the displaced-hash window.
