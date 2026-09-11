---
"@inkeep/open-knowledge-desktop": patch
"@inkeep/open-knowledge": patch
---

Opening a folder whose content hides behind a directory symlink or junction no longer hands the setup preview an unbounded walk.

Before OpenKnowledge previews a folder you have picked, it runs a size check to decide whether the folder is small enough to list in full. That check stopped at directory symlinks and Windows junctions, while the preview it guards follows them. A folder holding a handful of real entries plus a link to a large tree passed the check, and the preview then walked the whole tree. On large trees the setup screen froze for seconds, and on trees whose links fan out into themselves the app could run out of memory and quit.

The size check now follows the same links the preview does. A folder that turns out to be too large is reported as truncated, and the preview is skipped, so the setup screen stays responsive.

One case reads worse than it is. The size check skips only links named `node_modules` and `.git`, while the preview also skips links named for about thirty build and cache directories such as `dist`, `build`, `.venv`, `.cache`, `coverage` and `Library`, plus anything your `.gitignore` or `.okignore` lists. A folder whose bulk sits behind a link with one of those names is counted by the size check even though the preview would have skipped that link, so it can read as "Found ≥ 50,000 markdown files" with no sample list. This does not stop you from opening the folder. Folders holding those directories for real already counted this way.
