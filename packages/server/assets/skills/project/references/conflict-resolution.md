# Conflict-aware writes

A doc can land in conflict through a Git merge, a pull that collides with a local overlay, or OK's own reconciliation of the editor against disk. Reconciliation also protects an acknowledged edit when another app restores the exact older file version; that `stale-external-write` path works with GitHub sync disabled. The MCP server refuses a mutating call against a conflicted doc with a structured RFC 9457 response:

```json
{
  "type": "urn:ok:error:doc-in-conflict",
  "title": "Document is in conflict.",
  "status": 409,
  "detail": "The document is in a conflict state. Ask the user to resolve it in the OpenKnowledge app, then retry.",
  "file": "notes/sso.md",
  "conflict": { "kind": "reconcile", "reason": "disk-markers" },
  "resolutionOptions": ["mine", "content", "delete"]
}
```

The gate covers `write`, `edit`, `delete`, `move`, `restore_version`, and agent undo (the doc-CRDT write spine; template/folder ops are fs-direct). You cannot route around it by writing content that byte-matches one of the stages. The gate refuses on tracked state, not on body equality.

A write that first detects a stale file during its final disk flush returns `urn:ok:error:stale-external-write` (409). The edit reached collaborative state and the recovery snapshot, but the disk write did not happen. Ask the user to resolve it in the app, then re-read. Do not repeat the operation: a retried append can duplicate content already retained in the current version.

**You cannot resolve a conflict over MCP.** There is no conflict tool, and `exec` is read-only. On either 409, stop writing to that file, tell the user which file is in conflict, and ask them to resolve it in the OpenKnowledge app. After they confirm, re-read the document. For `doc-in-conflict`, the operation was refused; retry only if it is still needed. For `stale-external-write`, the operation already reached collaborative state; do not repeat it. Compare the resolved document with the intended result and make only any remaining edit.

## The three kinds

| `conflict.kind` | Where it comes from | What a resolve does |
| - | - | - |
| `merge-native` | a git merge left unmerged stages in the index | stages your choice with git, and commits the merge once no `merge-native` conflict is left (other kinds do not hold the commit back) |
| `working-tree` | a pull-only overlay collision, pinned to the origin blob it collided with | writes the chosen bytes to disk; nothing is committed |
| `reconcile` | OK's own three-way merge of the editor against disk, including stale external saves. No git object holds the stages, so OK snapshots them at detection | writes the chosen bytes to disk and into the loaded document; no git command runs |

A `reconcile` conflict carries a `reason`: `merged-with-markers` (the three-way merge produced markers), `refused-conflict-markers` (the disk bytes already carried markers), `refused-too-large` (the document is past the merge size cap), `disk-markers` (markers landed on disk under an open doc), or `stale-external-write` (an older displaced version returned on disk). The compatibility `conflictKind` field is `stale-external-write` for that last reason and `git` otherwise.

## What the user chooses

The controls depend on the conflict's shape:

| Shape | What the app shows | Controls |
| - | - | - |
| Conflict markers (`resolutionOptions` includes `content`) | The Conflict view, comparing both sides | **Accept current**, **Accept incoming** and, where available, **Accept both** for each conflict; the user then applies the resolution |
| Whole file, such as `refused-too-large` (no `content` option) | A preview of the user's version | **Keep my version**, plus **Use their version** and **Delete the file** when offered |
| Deleted locally, modified upstream | A preview of the upstream version | **Keep file deleted**, plus **Restore with remote changes** when offered |
| Modified locally, deleted upstream | A preview of the user's version | **Keep my version** or **Accept their deletion** |

For a stale external write, Current is the version OpenKnowledge protected and Incoming is the restored older version. `resolutionOptions` lists the strategies the app offers for that file; no MCP tool accepts them, so never try to apply one yourself. Explain what each choice would keep, but leave the choice and application to the user.

If applying a resolution fails, ask the user to inspect the remaining conflict in the app. OpenKnowledge retains unresolved conflict and recovery state. Wait for the user to finish, then re-read the document before deciding what work remains.

A conflict can also close without you. Resolving a merge with raw git outside the app prunes the `merge-native` entry on the next disk change or HEAD move, and a `reconcile` conflict whose file comes back clean on disk dissolves on the next watcher pass.

Stale-save recovery data lives in `.ok/local/stale-external-writes.json`, with owner-only permissions. Do not delete that file or restart with empty state when it is corrupt or unreadable; it may hold the only copy of protected edits. Preserve it, restore a known-good backup, and run `ok bug-report` from the project directory for diagnostics. An unresolved conflict does not expire with the displaced-hash window.
