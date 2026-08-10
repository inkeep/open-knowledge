---
'@inkeep/open-knowledge-server': patch
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge-core': patch
'@inkeep/open-knowledge-app': patch
---

A new project now starts with a commit, so its default branch actually exists. Setting up a project ran `git init` but never committed, which left the repository with no commits at all: `main` pointed at nothing, and anything that had to resolve it failed. The most visible casualty was New worktree, which died with `Couldn't create the worktree. Try a different name.` no matter what name you typed, because the real error was `fatal: invalid reference: main` and no branch name could have fixed it. Projects that OK sets up now get an empty `Initial commit`, so `main` resolves. Your content is untouched: the commit is deliberately empty, so nothing of yours is staged or committed on your behalf, and a repository you created yourself is never committed into.

Worktree failures now say what actually went wrong. A repository with no commits gets its own message instead of the advice to pick a different name, and git's own error text appears under the dialog, so an unrelated failure like a lock file or a permissions problem is legible instead of reading as a bad branch name.
