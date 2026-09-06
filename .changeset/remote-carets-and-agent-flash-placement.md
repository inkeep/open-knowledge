---
"@inkeep/open-knowledge": patch
---

You can see where the other people in a document are again, an agent's edit lights up the paragraph it actually changed, and typing into a blank line no longer leaves a stray one behind.

- **Remote carets are back in the rich-text editor**, labelled with the collaborator's name in their colour. This had been missing since the editor moved to a single shared replica.
- **Carets now cross the two editing modes.** Someone typing in rich text shows up for you in source mode, and someone in source mode shows up for you in rich text. That never worked in either direction before.
- **A collaborator's caret no longer flickers or vanishes while they type**, and switching between modes no longer wipes it out.
- **A caret resting at the end of a paragraph is drawn there**, rather than a character early, and a caret on a blank line no longer paints an empty paragraph that is not in the document.
- **An agent write flashes the paragraph it edited.** The highlight used to wash whichever three blocks sat at the top or bottom of the document — right number of paragraphs, right colour, wrong place — because it guessed from the edge of the document rather than reading where the write landed. It also only replayed when a document was opened or re-synced, so a write arriving while you had the page open painted nothing accurate at all.
- **Typing into an empty line between two paragraphs no longer leaves a blank line behind it.** The line that was holding the empty paragraph open is now reclaimed when it gains text, so the paragraph count stays put when you switch to Markdown and back.
- **An edit arriving from someone else is no longer treated as something you did**: a preview tab stays a preview tab when an agent or a collaborator writes to it, instead of being promoted as though you had typed in it yourself.
