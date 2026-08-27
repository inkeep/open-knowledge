---
"@inkeep/open-knowledge": patch
---

Bug reports about scrolling and about the outline panel now carry the numbers needed to diagnose them. Two related blind spots.

The editor already measured a lot about restoring your scroll position when you return to a document, but those measurements only ever existed inside the running app and were never written down, so they went with the window when it closed and three separate scroll bugs were investigated without a single scroll measurement between them. Those measurements now also go to the app log a report collects, and each one identifies the document it belongs to along with how far down the document was scrolled, how tall it was, and how much of it was on screen — enough to tell "the editor scrolled past the end of the document" apart from "the content had not finished drawing yet", which previously took a purpose-built reproduction to establish.

Clicking a heading in the outline panel recorded nothing at all. If it took you to the wrong section, or appeared to do nothing, a report could not say which row was clicked, which heading answered, or whether the editor scrolled. It now records all three, in both the visual and the source editor, including the case where something else was already controlling the scroll position and the click was correctly declined — which looks identical to a broken click from the outside. It also records where the clicked heading actually sits in the document, so an outline whose rows have drifted out of step with the page reports the size of the drift directly instead of presenting as an unreproducible complaint.

Headings are user-written text and no report has ever included document prose, so none of this records the heading text itself — the positions alone answer the question.
