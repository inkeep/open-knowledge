---
'@inkeep/open-knowledge': patch
---

Agent chat threads now scroll like a real chat client. The transcript keeps itself pinned to the newest output while an agent is streaming, but the moment you scroll up to read something it stops fighting you — and a button appears to jump back to the live edge when you're ready.

| Before | After |
| --- | --- |
| Scrolling up mid-stream was undone by the next chunk snapping you back to the bottom | Scrolling up holds; new output no longer yanks the view |
| No way back to the latest message except scrolling by hand | A jump-to-bottom button returns you to the live edge |
| Reopening a past thread dropped you at the very bottom | Reopening lands you at the last turn, with the previous message in view |

Sending a message still brings you straight to the bottom so you see your prompt and the reply. Long threads with many tool calls also render more cheaply, since off-screen rows are no longer laid out until they scroll into view.
