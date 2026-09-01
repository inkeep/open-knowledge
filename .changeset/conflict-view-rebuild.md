---
"@inkeep/open-knowledge": minor
---

Merge conflicts get a rebuilt resolution view.

Every conflicted region now carries **Accept current**, **Accept incoming**, and **Accept both**, and the differing words inside a region are highlighted, so two long paragraphs that disagree on one clause no longer have to be compared by eye. **Undo** and **Redo** step back and forth through resolutions, and nothing is written until you press **Apply changes**.

**Show original** reveals the version both sides started from. Current-and-incoming alone shows you two endpoints, not two intentions: when a sentence is shorter on one side, that is either someone trimming a clause or you having deleted one, and those call for opposite resolutions while looking identical. The original tells them apart. It stays hidden until asked for, so a conflict still opens as the familiar two-way comparison.

Handing the file to an agent no longer means retyping the request: opening a conflicted document seeds the Ask AI composer with the resolve instruction, staged for you to read and extend rather than sent — resolving writes to disk and commits, so it waits for you.

Conflicts where one side is missing the file entirely — you edited and they deleted it, they edited and you deleted it, or you both added it with no shared history — now each explain themselves, so an empty pane never reads as a view that failed to load.

Resolutions round-trip byte for byte, including CRLF line endings, leading tabs, and trailing spaces. The one normalisation: when the two sides disagree about whether the file ends with a newline, the result ends with one.

A document can contain a line that looks exactly like a conflict marker — a heading underlined with `=`, a divider rule, or a quoted marker in a note about git. Inside a conflicted region there is then nothing to say which line is structural, and resolving against the wrong one drops your own text. Such a file is now refused with an explanation rather than resolved: the buttons do not appear, and it stays yours to resolve by hand or with your agent.

Several fixes ride along. Undoing a resolution used to leave the last conflict in a file with no buttons for the rest of the session. A resolution still carrying conflict markers — something an agent can produce when asked to fix one region and leave the others — was written to disk and marked resolved, leaving a broken document behind a clean conflict list; that is refused now, without also turning away the ordinary documents whose prose happens to contain a row of `=`. A conflict whose three-way merge comes back clean now offers Apply instead of stranding the file with no way to resolve it. A file both sides left unterminated stays unterminated. Apply commits once however fast you click it.
