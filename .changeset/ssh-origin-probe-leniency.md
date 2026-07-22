---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
'@inkeep/open-knowledge-core': patch
---

**Fix:** auto-sync no longer silently pauses for SSH-origin remotes with no
GitHub credential. The push-permission probe used to treat "no gh/OK token"
as signed-out and pause sync with a Sign-in prompt — wrong for self-hosted
forges (Gitea/Forgejo) and github.com-over-SSH setups, where pushes
authenticate with SSH keys and no OK sign-in path can ever help. The probe
now keys off the origin transport: HTTPS origins keep the signed-out denial
(and its Sign-in affordance, including GHES); `ssh://`, scp-style, and
`git://` origins abstain with a new `unknown/ssh-unverified` result, so sync
proceeds and the real push decides.
