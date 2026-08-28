---
"@inkeep/open-knowledge": patch
---

A bug report from a desktop freeze while opening a folder now names the step the open had reached.

Opening a folder runs a long admission funnel: working out what the picked folder actually is, confirming an ancestor project, the first-open consent dialog and its content probe, git and content scaffolding, the editor and AI-tool writes, and finally the window itself. Until now that whole stretch reported one line as it started and one line once the window existed, and nothing in between. Every diagnostic along the way was a `console.warn`, which the packaged app discards. A session that stopped anywhere inside the funnel therefore produced a report indistinguishable from one that stopped anywhere else, which is why several reports of a freeze right after picking a folder could establish that the app had stopped and not where.

The funnel now reports one line per decision it makes and per step that can run long, on both the first-open and existing-project paths: entering the admission resolution, the folder-size probe and the git-root lookup inside it, what the pick resolved to and whether it was promoted to an ancestor folder or a git root, each dialog being raised and the answer coming back, the waits for the Navigator to load and for git and content scaffolding, the artifact writes, and entering the window creation rather than only finishing it. A report now points at one step instead of the whole funnel. Creating a new project resolves the new folder's location through a separate admission pass before this funnel is reached, and that pass is not covered; the open that follows it runs this funnel and reports the steps that apply to it.

The size probe that decides whether an oversized ancestor needs confirmation also reports its own failure through the same log. That failsafe quietly changes which branch the open takes, and it previously said so only on a sink the shipped app throws away.

One line per step per open. The new lines carry folder names, enumerated states, counts and booleans rather than file contents. The probe failure is the exception, and deliberately so: it reports the error itself, whose message carries the path the probe could not read, because knowing which failure flipped the branch is the reason that line was promoted off the discarded sink in the first place.
