---
'@inkeep/open-knowledge': patch
---

Repair a damaged managed runtime instead of telling the user to delete a directory.

When OK's own downloaded Node.js/uv was present but couldn't run — an interrupted extraction, a clobbered launcher — the launch failed with "delete that directory and OK will download a fresh copy on the next launch". That is homework in a terminal for a copy the user never installed and can't inspect.

OK now discards the damaged copy itself and offers to download a fresh one, with the same consent card and progress the first download uses. Three outcomes stay honest about which one happened: declining says OK's copy is damaged (not that the interpreter is missing); a replacement that also won't run points at the machine (antivirus, security policy, unsupported CPU) rather than at a system Node that was never involved; and a copy that can't be moved aside — another agent still holding it open, which is how this fails on Windows — says so instead of claiming a fresh download failed.

The repair is one attempt per launch, and every download is still gated on the prompt, so nothing refetches behind the user.
