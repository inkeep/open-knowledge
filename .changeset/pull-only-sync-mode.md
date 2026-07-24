---
"@inkeep/open-knowledge": minor
---

Add Follow — a one-directional sync mode for people who follow a knowledge base they can read but not push to (share-link recipients and read-only followers).

Previously, opening a repository you lacked push access to left your copy silently frozen: the sync onboarding prompt was suppressed, no sync config was written, and the engine parked itself the moment a push was denied. Follow fixes that dead end.

What it does:

- Keeps your local copy current automatically by fast-forwarding to the latest on GitHub, without ever pushing or committing on your behalf.
- Lets your own uncommitted edits ride safely on top of incoming updates. Non-overlapping changes combine automatically; edits to the same lines the upstream changed surface in the familiar conflict view, where you choose keep-mine or take-theirs. Your branch always tracks the upstream tip and never forks.
- Is always opt-in. Push-denied users are now offered Follow at first open with plain-language copy ("updates flow in from GitHub; your edits stay on this computer"), and anyone can choose Off / Follow / Full in Settings. A project owner can commit `autoSync.default: follow` so a fresh clone starts following.

Also included:

- Full-sync users who lose push access now get a "Switch to Follow" action on the sync-paused notice instead of a silent stall; switching keeps any unshared local commits as a local overlay.
- The sync status badge stays visible for a followed project and shows a distinct following state (updating / up to date / conflict / offline).
- Anonymous followers of public repositories poll more gently than signed-in followers.
- A one-shot "Sync" pull that reports its outcome, for surfaces that need an on-demand refresh.

Configuration note: the sync preference is now stored as a single `autoSync.mode` (`off` / `follow` / `full`). Existing `autoSync.enabled` settings keep working, and choosing a mode clears the legacy flag so the two can't disagree across versions. An app that predates `autoSync.mode` then reads the config as unanswered and re-prompts rather than acting on a stale toggle, so it never pushes for a mode you didn't consent to there.
