---
"@inkeep/open-knowledge": patch
---

Reworked commenting so writing a note and sending a batch are two clearly separate steps.

- **The selection toolbar's "Ask AI" is now "Comment"** (same sparkle). It opens the same composer as before, but the composer no longer offers "Send to AI" — a comment goes into the queue, and dispatching is something you do deliberately from the Comments tab, which the composer now offers a direct route to. The hidden ⌘Enter that used to hand a comment straight to an agent is gone with it, along with its entry in the shortcuts list; Enter posts.
- **The Comments tab's two sides are now "This doc" and "This project", and they are the same list.** The project side used to show only comments already marked to send, so the two halves of one tab answered different questions. Both now list every comment — the project side grouped under the file it sits on — with a checkbox on each saying whether it goes out, a running count of what is checked, and a "Send to chat" button. Ticking a comment on one side ticks it on the other.
- **File groups fold.** Each file in the project view has a disclosure, plus one control in the panel header to collapse or expand them all. Groups start expanded.
- **Comments always go to an in-app agent, and to the chat you already have open.** A batch used to resolve the same destinations as the Ask AI composer, so a standing preference for a CLI sent your review comments to the terminal. It now starts an in-app thread, or runs as the next turn in the thread you are already in — with anything typed there carried along as the batch's instruction. The picker beside the button chooses which agent, not which kind of surface.
- **⇧⌘Enter sends what the open Comments tab is showing.** On "This doc" that is one document's checked comments; on "This project", every checked comment. With the tab closed it does nothing and leaves the key alone — it used to send the whole project queue, which gave the chord its widest reach exactly when nothing on screen said what was in it.
- **A comment is settled by sending it.** The per-comment "Resolve" button is gone: handing a comment to an agent resolves it, and "Reopen" is still there for when the agent did not actually settle the thing. Deleting is the way out for a comment you decided against.
- **Fixed: a send button could not see the conversation you had open.** Both docks published into one slot, so the terminal dock reporting its empty tab list erased the agents panel's live thread — every surface outside the docks then offered to start a new chat while one sat open on screen.
- **Fixed: the comment card in the document showed its send checkbox permanently unticked**, however many times you clicked it, while the click itself went through.
- **Comment ages older than a day read properly.** The timestamp on a card counted up in hours forever, so a week-old comment showed "174h"; it now rolls over to days, and past a week shows the date.
