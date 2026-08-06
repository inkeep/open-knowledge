---
'@inkeep/open-knowledge': patch
---

The editor no longer jumps to a different file on its own while you're reading. Follow-the-file — the feature that walks the editor along as an agent creates and edits pages — was doing two things it shouldn't:

- **A background agent could steal your place.** Every open agent conversation stays live at once, so an agent working in a tab you weren't looking at could still yank the editor onto whatever file it wrote next. Now only the conversation you're actively viewing (its tab selected, the dock on screen) moves the editor.
- **It overrode where you navigated.** If you opened another page to read while an agent kept working, its next write pulled you back. Now, once you navigate somewhere the agent didn't send you, follow steps aside and leaves you there for the rest of that turn. It picks back up on the next turn, or when you toggle follow off and on.

Follow still does its job on the golden path: start an agent, watch the editor track its work. Turn the follow toggle off in the conversation header to opt out entirely.
