---
"@inkeep/open-knowledge": patch
---

An ACP agent whose credentials expire mid-conversation now returns the transcript to the sign-in surface with the reauthentication buttons the initial connection advertised, instead of parking the failed turn behind the opaque "Your message didn't reach X" card that had no path back. The prompt-catch on the server treated every non-cancel rejection as a generic `prompt` failure, so an auth-required rejection coming back from `session/prompt` never reached the same sign-in machinery `session/new`'s auth-required branch already had — mirroring that branch closes the gap, and the auth-error classifier now recognizes both the ACP standard `-32000` shape and the Claude Agent SDK's `-32603` + `data.errorKind === "authentication_failed"` shape it emits for mid-turn OAuth expiry. The still-live agent process stays alive across the sign-in, so `authenticate` runs on the same connection the initial handshake set up.
