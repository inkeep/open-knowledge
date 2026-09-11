---
"@inkeep/open-knowledge": patch
---

Collaborators' carets stay where they are after a trailing space, and your own caret and selection stay put while someone else edits the document.

Before, typing a space at the end of a paragraph made your caret show at the start of the next paragraph for everyone else, in both the visual and the Markdown source editor. If a collaborator then typed anywhere, your own caret jumped there too, so the next thing you typed landed in the wrong paragraph. Any edit by someone else also collapsed a text selection to a caret and deselected a selected image or component. Carets, selections, selected images and components, and select-all now survive another person's edit.
