---
"@inkeep/open-knowledge": patch
---

Record what the server actually bound, and stop the spawn-error log destroying its own evidence.

A `server.lock` advertises a port, but until now nothing recorded that a server had bound one — so a diagnostic bundle could not tell a live listener from a stale advertisement, or say which process owned a port when two servers had run for the same directory. The server now logs its pid, port, bound addresses and base URL at listen time.

`last-spawn-error.log` was opened in truncate mode on every spawn, so a retry seconds after a failed spawn destroyed the output explaining the failure it was retrying. Both documented writers of that file — the desktop spawn and the MCP shim — now append behind a per-attempt header and start over only at a size cap, sharing one policy so neither erases what the other accumulated. The spawn-failure report bounds its stderr tail to the current attempt, so a child that dies silently no longer inherits the previous attempt's stack trace as its cause.
