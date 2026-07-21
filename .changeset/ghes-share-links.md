---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
'@inkeep/open-knowledge-core': patch
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge-app': patch
'@inkeep/open-knowledge-docs': patch
---

**Feat:** share links now work with GitHub Enterprise Server remotes
(PRD-7351). The construct side threads the origin host into the share URL,
and the receive pipeline carries the host as part of the repo identity end
to end — so a GHES `owner/repo` share never resolves to a same-named
github.com clone. Because a decoded deep link is untrusted input, a share
pointing at a non-github.com host is gated: it proceeds silently only for a
host the recipient is already authenticated to, otherwise the app prompts to
open the link in a browser instead. The web splash renders enterprise shares
with the host shown prominently.
