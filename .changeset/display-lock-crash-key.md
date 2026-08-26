---
"@inkeep/open-knowledge": minor
---

Crash reports from the desktop app now record what the editor's block-level `content-visibility` was doing when a renderer died.

One class of renderer crash aborts inside Chromium when a click lands on content whose ancestor has just been made unpaintable. The minidump in a bug report carries the faulting stack but nothing about the page, so triage could establish that the crash happened and not whether the editor's block wrappers were changing state at the time. That gap made the difference between a diagnosis and an informed guess.

The renderer now keeps a small crash key current as those blocks change state, and a bug report that carries a crash dump surfaces whatever the dump captured. Reports that carry no dump are unchanged, and a report from a renderer that never published a value says so explicitly rather than reading as "nothing was happening".

The reading also says whether it was current. A crash during a burst of changes is recorded differently from one that happened long after the last change, so a value in a report cannot be mistaken for evidence that something was happening at the moment of the crash when it was not.

It covers the editor's block wrappers only. The other place the app uses this CSS feature cannot report state changes at all, by design of the underlying browser event, so a crash there records nothing about that site rather than something misleading.

What is recorded is a short fixed-shape string of counters and flags. It carries no document content, no file paths, and no user data. It appears in the crash dump and, like other diagnostic decisions, in the desktop log that any bug report bundles.
