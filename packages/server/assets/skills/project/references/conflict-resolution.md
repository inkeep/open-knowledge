# Write outcomes and conflicts

A document, template or skill write through `write` or `edit`, a document `restore_version` and a `lint` fix that changed the doc carry three fields once the server answers, success or not: `outcome` (what happened to the write), `saved` (whether its bytes were in the file when the server answered) and `nextStep` (what to do next). Read them before anything else in the result, and follow `nextStep`.

| `outcome` | What happened | `saved` | Your move |
| - | - | - | - |
| `applied` | The write landed and is saved. | `true` | Carry on (`nextStep: none`); with a `content-divergence` warning `nextStep` is `re-read` (below). |
| `merged-first` | An outside change to the file was handled before your write was saved: merged in, or saved to the doc's history when it could not be merged. Your write landed. | `true` | Re-read before the next edit (`exec("cat <path>")`). Never repeat the write. |
| `both-kept` | Your write landed and is saved. A block was changed both here and outside, so both versions are in the doc, this doc's version first and the outside version directly under it. | `true` | Never repeat the write. Re-read, and remove the duplicate with an ordinary `edit` if your task calls for it. |
| `refused` | Not saved. OpenKnowledge saves it only after someone acts: you, as `nextStep` says, or the user. | `false` | Follow `nextStep`: `retry` means send it again, corrected the way the detail says (a fixed path, quoted YAML, a different name) or after the wait it names; `re-read` means re-read, then re-apply only what is missing; `none` means nothing you send changes it, so tell the user (below). |
| `projection-held` | Your write is in the doc but not yet in its file; OpenKnowledge saves it on its own. On OpenKnowledge Cloud the same outcome means the doc's file projection is held. | `false` | Never repeat the write. Re-read before the next edit. |

A `both-kept` or `projection-held` result comes back as an error result because it is not plain success, but its text starts by saying the write landed: do not repeat it. A batch reports these per entry in `documents[]`, and a skill write per file in `skill.files[]`. If `outcome` holds a value you do not know, treat it as `merged-first` when `saved` is true and `refused` otherwise, and re-read; treat an unknown `nextStep` as `re-read`. If there is no `outcome`, the server predates the fields: read the result text. `retryWhen` and a warning's own `nextStep` are older fields; ignore them.

## What each result asks of you

The fields come from one table on the server, and this one repeats it: for every result below, the move matches its `nextStep`. With `none`, nothing you send changes the result: stop writing to that file, tell the user which file it is and what the result says, and carry on with other work; do not wait on them. **You cannot resolve a conflict over MCP**: there is no conflict tool, no write tool takes a conflict parameter, and `exec` is read-only. Never work around a refusal by writing the same content somewhere else.

| Result | `outcome` | `saved` | `nextStep` | Your move |
| - | - | - | - | - |
| `both-kept` (409) | `both-kept` | `true` | `re-read` | Never repeat the write. Re-read, and remove the duplicate with an ordinary edit if your task calls for it. |
| `applied` (200) with a `content-divergence` warning | `applied` | `true` | `re-read` | The write landed and is saved, but the stored text differs from what you sent. Re-read before the next edit. |
| `concurrent-overwrite-refused` (409) | `refused` | `false` | `retry` | Wait the seconds `retryAfterSeconds` names, then send the write again; an `append` or `prepend` is never refused this way. |
| `too-many-agent-sessions` (503) | `refused` | `false` | `retry` | Wait the seconds it names, then send the write again. |
| `doc-not-found` (404) | `refused` | `false` | `retry` | Send the edit again at the path the detail or `candidates` names. |
| `reserved-doc-name` (400) | `refused` | `false` | `retry` | Send the write again under a different name. |
| `frontmatter-malformed` (400) | `refused` | `false` | `retry` | Fix the YAML the detail points at, then send the write again. |
| `frontmatter-edit-not-supported` (400) | `refused` | `false` | `retry` | Send the frontmatter change again as a frontmatter patch. |
| `invalid-frontmatter-patch` (400) | `refused` | `false` | `retry` | Correct the patch the detail describes, then send it again. |
| `target-not-found` (404) | `refused` | `false` | `re-read` | Re-read the document, then make the edit against text that is there. |
| `stale-target` (409) | `refused` | `false` | `re-read` | Re-read the document, then make the edit against what is there now. |
| `doc-in-conflict` (409) | `refused` | `false` | `none` | Tell the user which file it is. Write to it again only after they say the conflict is resolved. |
| `stale-external-write` (409) | `refused` | `false` | `none` | Tell the user which file it is. Your edit is kept in the document and the recovery snapshot; do not repeat it. |
| `save-held` (503) with `pending-conflict` | `refused` | `false` | `none` | Tell the user which file it is. The save runs once they deal with the file in the app; do not repeat the write. |
| `save-held` (503) on a file with no agreed version | `refused` | `false` | `none` | Tell the user its file changed outside OpenKnowledge, and do not write to that document again: any write replaces it with the file on disk and moves your edit to its history. |
| `save-held` (503) with `pending-not-utf8` | `refused` | `false` | `none` | Tell the user which file it is: it now holds bytes that are not text, so it is not written over, and no save runs until someone saves it as text again. Do not repeat the write. |
| `save-held` (503) with any other `reason` | `projection-held` | `false` | `re-read` | Do not repeat the write. Re-read before the next edit; with `pending-rename`, re-read at the new name the detail gives. |
| `doc-moved` (409) | `projection-held` | `false` | `re-read` | Do not repeat the edit. Re-read the document at the new name the detail gives. |
| `branch-switched` (409) | `projection-held` | `false` | `re-read` | Do not repeat the edit. Re-read the document before the next edit. |
| `doc-removed` (409) after a rename | `refused` | `false` | `re-read` | Re-read the document at the new path the detail names, and re-apply your change there if it is missing. |
| `doc-removed` (409) after a delete | `refused` | `false` | `none` | Tell the user the file is gone; the edit is in the document's history (timeline). Do not re-create the document on your own. |
| `server-stopped` (503) | `refused` | `false` | `none` | Tell the user; after the restart the edit is in the document's history (timeline). |
| `server-stopped` (503) during a move | `refused` | `false` | `re-read` | After the restart, re-read the document at the new name the detail gives, and re-apply the edit only if it is missing. |
| `path-escape` (400) | `refused` | `false` | `none` | Tell the user the document's path could not be resolved. |
| `store-refused` (503) | `refused` | `false` | `re-read` | Do not repeat it now. Once the user has fixed the filesystem fault, re-read and re-apply only what is missing. |
| `write-replaced` (409) | `refused` | `false` | `re-read` | Re-read: the document now holds the file as it is on disk, and your edit is in its history. Re-apply it if it is still needed. |
| `write-dropped` (409) for a name with no file of its own | `refused` | `false` | `retry` | Send the write again by the skill's or template's file path. |
| `write-dropped` (409) while an outside change was being taken in | `refused` | `false` | `re-read` | Re-read the document, which now holds the outside change, and re-apply the edit if it is still missing. |
| `write-dropped` (409) for a skill folder that is gone or a path that does not resolve | `refused` | `false` | `none` | Tell the user which skill it is: its folder was deleted or moved, or its path no longer resolves. |
| `storage-full` (507), `storage-readonly` or `storage-error` (500) | `refused` | `false` | `re-read` | Once the user has fixed the storage, re-read and re-apply only what is missing. |

If you come back to that file later, re-read it first. For a refusal before anything was written (`doc-in-conflict`), write again only if the write is still needed; otherwise compare the doc with the intended result and make only the edit that is still missing.

Stale-save recovery data lives in `.ok/local/stale-external-writes.json`, with owner-only permissions. Do not delete that file or restart with empty state when it is corrupt or unreadable; it may hold the only copy of protected edits. Preserve it, restore a known-good backup, and run `ok bug-report` from the project directory for diagnostics.

## Git conflicts

A Git merge or a pull that collides with local edits puts a doc in conflict until the user resolves it in the app. `conflict.kind` says which:

| `conflict.kind` | Where it comes from | What a resolve does |
| - | - | - |
| `merge-native` | a git merge left unmerged stages in the index | stages your choice with git, and commits the merge once no `merge-native` conflict is left (other kinds do not hold the commit back) |
| `working-tree` | a pull-only overlay collision, pinned to the origin blob it collided with | writes the chosen bytes to disk; nothing is committed |

The controls depend on the conflict's shape:

| Shape | What the app shows | Controls |
| - | - | - |
| Conflict markers | The Conflict view, comparing both sides | **Accept current**, **Accept incoming** and, where available, **Accept both** for each conflict; the user then applies the resolution |
| Deleted locally, modified upstream | A preview of the upstream version | **Keep file deleted**, plus **Restore with remote changes** when offered |
| Modified locally, deleted upstream | A preview of the user's version | **Keep my version** or **Accept their deletion** |

Explain what each choice would keep, but leave the choice and its application to the user. If applying a resolution fails, ask the user to inspect the remaining conflict in the app; wait for them to finish, then re-read the doc before deciding what work remains. Resolving a merge with raw git outside the app prunes the `merge-native` entry on the next disk change or HEAD move.
