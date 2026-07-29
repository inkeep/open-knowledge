---
'@inkeep/open-knowledge': minor
---

Blank lines you type in the visual editor now stay where you put them. Previously the editor showed the space while you were typing and then quietly took it back — switching to markdown source and returning, reloading the page, or a teammate opening the same document all collapsed a run of blank lines down to one.

| Before | After |
| --- | --- |
| Press Enter three times, reload — one blank line | Press Enter three times, reload — three blank lines |
| The file on disk kept your blank lines, the editor did not show them | The editor shows what the file actually contains |

This covers blank lines between top-level blocks, which is where they come from when you press Enter. Two places still collapse them, both deliberately: runs at the very top or very bottom of a document, and runs inside a list, a quote, or a table cell — where CommonMark treats the blank line as meaningful structure rather than space. Nothing new is written into your files: no `&nbsp;`, no `<br />`, just the newlines that were already there.

Worth knowing: blank lines still render as nothing when a document is published to GitHub or any other CommonMark renderer. This makes the editor honest about your file, it does not add vertical space to published output.
