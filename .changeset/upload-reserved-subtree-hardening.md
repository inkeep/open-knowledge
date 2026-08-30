---
"@inkeep/open-knowledge": patch
---

Refuse writes routed into `.ok`/`.git` through the upload API, and stop blaming the caller for a missing content directory.

`/api/upload` now rejects a destination inside a reserved subtree: a `parentDocName` that names or symlinks into `.ok`/`.git`, and a configured `content.attachmentFolderPath` that points there, both return `400 urn:ok:error:reserved-doc-name` where they previously wrote agent-loaded content into `.ok/skills/` with no validation. The check runs on the resolved destination directory, so a directory symlink planted in a cloned tree cannot route around it. The same canonical check now also covers the source path of a rename and the create-folder/duplicate-path/delete-path routes, and a `.ok/templates` directory that is itself a symlink is skipped when building the templates menu. The same canonical check now also gates `GET/PUT /api/folder-config`, the `/api/template` family including `/api/template/import`, and the folder-mode `GET /api/history?folder=`.

Separately, a content directory that is missing at request time (deleted under a running server, unmounted volume) now surfaces as a 500 server error instead of a 400 path-escape blaming the request, and symlink escapes on create-folder, duplicate-path and delete-path return the documented `400 urn:ok:error:path-escape` instead of a generic 500.
