---
"@inkeep/open-knowledge": patch
---

Auto-sync is no longer silently disabled for projects whose `origin` is a self-hosted Git forge (Gitea, Forgejo, …). The push-permission probe presumes any host that is not a known non-GitHub forge is GitHub or GitHub Enterprise Server, since GHES hostnames are arbitrary. When no GitHub token could be resolved for such a host, the probe previously returned `denied` without any network call, which paused sync with "You don't have permission to push to this repo" — even though the user pushes fine over SSH. The probe now only treats an anonymous (no-token) result as `denied` for `github.com`; for any other host it returns `unknown`, so sync stays enabled and the real push attempt surfaces a genuine error only if it actually fails. Behavior for `github.com` and for GHES hosts with a resolvable token is unchanged.
