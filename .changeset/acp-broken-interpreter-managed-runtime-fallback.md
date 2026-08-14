---
'@inkeep/open-knowledge': patch
---

In-app agents no longer die with an unreadable error when the Node.js or uv on your machine is broken.

OK checked that `npx`/`uvx` existed before launching an agent, but not that it could actually run — so an interpreter that was installed yet fatally broken (on macOS, most often a Homebrew `node` whose `icu4c` library was upgraded out from under it) launched an agent that aborted before it could say hello. All you saw was `initialize failed: ACP connection closed`, with nothing to act on. OK now checks that the interpreter runs, and a broken one gets the same offer a missing one already got: OK downloads and uses its own private copy of Node.js or uv, with your consent. If you decline, the message now says the interpreter is installed but failing rather than claiming it isn't installed.

Agent failures also reach the server log now, so a bug report carries them. The last thing a dying agent wrote to its error output — the linker error, the stack trace — was previously visible only in the chat panel, which meant a diagnostic bundle filed for an agent crash contained no evidence of it. An agent that exits unexpectedly mid-session is logged too.
