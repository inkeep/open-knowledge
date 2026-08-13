---
'@inkeep/open-knowledge': patch
---
Clicking a commented property value now opens its thread, the way clicking a commented passage in the body always has. The body gets that from the editor — the highlight is a decoration the editor can hit-test — while a property value is a plain form control with no decorations and no positions, so the same gesture had to be assembled from the caret offset a click sets. 

Each comment now carries when it was last revised, so an edited comment reads as edited instead of showing its creation time.

The passage a comment is on now renders as a quote in the agent transcript. Sending a batch composes each comment as its document, the selected text as a blockquote, and the note itself — but the transcript printed sent messages verbatim, so that structure arrived as flat text with the `>` markers showing and every line run together. Sent messages render as markdown now, so the passage reads as a quote under the file it came from and the note reads beneath it.
