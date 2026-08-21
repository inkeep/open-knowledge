---
"@inkeep/open-knowledge": patch
---

OpenKnowledge now suggests Codex in the agent picker when you are already signed into Codex Desktop, even if you have never installed the `codex` command line tool. Previously the only thing that could put an agent in the "In app" list unprompted was finding its CLI on your PATH, which meant a Codex Desktop user saw no Codex row despite having everything needed to use it — the adapter brings its own runtime, and Codex Desktop and the CLI share the same sign-in. The catalog now reports an existing sign-in as a second, independent signal alongside the PATH check, and either one is enough.

The signal only ever adds an agent to the list, never removes one. Not finding a sign-in means nothing, since Codex can keep credentials in a system keyring with nothing on disk to find; and finding one is not proof the session still works, since an expired sign-in stays on disk until you run `codex logout`. So a suggested agent may still ask you to sign in. Agents you have turned on yourself are unaffected, as always.
