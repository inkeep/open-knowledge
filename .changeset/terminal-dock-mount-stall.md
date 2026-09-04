---
"@inkeep/open-knowledge": patch
---

Opening the terminal on a cold start no longer risks an empty dock that never fills in.

The dock waits for your saved terminal tabs to be read back before it shows anything, and that read had no time limit. If it stalled, the dock opened and then stayed empty forever: no terminal, no message, and no way out short of reloading the window. A dock that was open when you last quit could stay empty even after the read finished, because nothing started a terminal once the restore was given up on.

The read is now bounded. If it does not come back in time, comes back empty, or errors outright, the dock starts a fresh terminal instead of waiting, so you get a working shell rather than an empty panel. One case is different: if the check for shells that survived the restart fails, a dock being restored stays empty rather than opening a second shell on top of one that may still be running. Any shells that were still running are left running rather than being closed, and the timeout and any shells left behind are written to the log.

The tradeoff worth knowing: whenever the restore does not complete, whether it timed out, the saved state could not be read, the surviving-shell check failed, or the restore errored, that window stops saving tab changes entirely, so your previous tabs survive to the next launch untouched. Opening, closing, renaming and reordering tabs still work for the rest of that window, they just are not remembered. That is deliberate, because a window that never learned what you had saved should not overwrite it with less. A line is written to the log the first time a save is skipped.

The "Starting terminal…" spinner also explains itself now. If startup runs long, it adds a line saying so and offers a Reload button, while continuing to wait, so a slow start still finishes on its own.
