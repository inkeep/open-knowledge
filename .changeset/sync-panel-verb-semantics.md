---
"@inkeep/open-knowledge": minor
---

Git sync gets a rebuilt control panel and mode-independent manual actions.

The sync popover now carries a three-way mode selector — **Manual**, **Auto (Pull only)**, **Auto (Pull and Push)** — plus manual **Pull**, **Push**, and **Pull and Push** buttons that behave identically in every mode: the mode only chooses what runs on a schedule. Pull never commits your in-progress work in any mode; Pull and Push runs the classic sync (commit, push, merge). The panel's status section lists which files a pull would bring in, which files a push would include, and which changed files sit outside OpenKnowledge's commit scope and would be skipped — refreshed by a read-only fetch when the panel opens. Settings and the enable dialogs use the same mode names.

How often the automatic modes run is now configurable per machine: **Settings → Sync → Advanced** adds **Check for updates every** and **Push my edits every** (30 seconds to 1 hour), stored as `autoSync.pullIntervalSeconds` and `autoSync.pushIntervalSeconds` in the project-local config. When a pull is blocked because your uncommitted local changes overlap an incoming update, the popover now lists the blocked files under **Changed here and on the remote** with a **Commit and sync** button that commits exactly those files and resumes, plus a **Resolve in terminal** handoff (desktop app) for stashing or discarding by hand — OpenKnowledge never discards uncommitted work for you.

Two fixes to what a pull does with files it cannot merge cleanly. When an incoming change collides with a local edit to a non-document artifact, Pull now keeps your version rather than failing the whole pull — the Pull verb's disposition is keep-mine, and previously a single dirty artifact overlapping an incoming change would abort everything else the pull had to deliver. Separately, sync's own shareable files under `.ok/` (the ones it legitimately writes) are no longer refused by the symlink guard's state-directory check, which had been rejecting them by resolved path.

Three smaller changes ride along. The panel's freshness line now reports each direction separately (`↓ 2m ago · ↑ 5m ago`) instead of one "Updated" timestamp that only ever reflected whichever direction ran last. An **Advanced settings** link in the popover opens Settings → Sync with the Advanced section already expanded. And when a new worktree inherits its sync setting from the root project, the notice names the mode exactly as the Settings control labels it, rather than using retired wording.
