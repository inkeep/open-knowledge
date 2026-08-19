---
"@inkeep/open-knowledge": patch
---

A failed ACP prompt now offers an "Edit and resend" action that pulls the message text back into the composer, so the reader doesn't have to retype it to try again after changing a setting (a smaller context window, a different model, an added attachment). The card previously offered no action at all — the reasoning was that "sending it again IS the retry," but the composer had already cleared and the message text was only visible in the transcript row above the notice. Only the most-recent prompt failure carries the button (mirroring the Retry button's one-card discipline), and the transcript keeps the failed attempt as history. Text-only for now — attachments still need to be re-picked.
