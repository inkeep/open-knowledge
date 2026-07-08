---
"@inkeep/open-knowledge": patch
---

Fixed the project switcher's worktree list not refreshing until an app restart. A worktree created outside the current window — a `git worktree add` in a terminal, or a create in another OpenKnowledge window — now appears when the window regains focus, instead of staying hidden until you quit and reopen. The cached worktree model now revalidates on window focus / tab-visible, the same signal the file list and graph already use to recover from stale data.
