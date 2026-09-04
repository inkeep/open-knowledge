---
"@inkeep/open-knowledge": patch
---

The bug reporter can now carry your own images and a contact email.

- **Attach your own screenshots or photos.** The report dialog has a "Your images" row that takes up to 3 PNG, JPEG, or WebP images alongside the automatic screenshot — the cases the automatic capture structurally cannot show, like a native system dialog, a second monitor, or a phone photo of a hang. They land inside the diagnostic zip you can inspect before sending, and inline in the ticket next to the automatic screenshot. Images are not redacted, which the row says, and removing one before you create the report is one click. A failed image upload never fails the report.
- **Leave an address, once.** A "Share your email for followups" checkbox reveals an email field, the same control the feedback form already has. Unchecked, it never blocks sending. Checked, the address rides the report so the team can reply — which is what reporters have been improvising by typing their name into the note, where it becomes the ticket title.
- **The address is remembered, and forgettable.** Once given it prefills next time, on both the bug reporter and the feedback form: one stored value, two surfaces, so the feedback form stops asking you to retype it on every send. Unchecking the box and sending deletes the stored address rather than just switching a flag off — reopen and the field is empty, with nothing recoverable by re-checking it. The value stays on your device and is transmitted only inside a report you sent with the box checked.

Released desktop builds keep filing exactly as they do today: every wire change is additive, and a client that sends neither field produces a byte-identical ticket.
