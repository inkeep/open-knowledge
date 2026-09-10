---
"@inkeep/open-knowledge": patch
---

Connect GitHub and Clone repository work again on Windows Desktop.

Both failed instantly with `spawn EINVAL` on every packaged Windows install since 0.47.0, the first release to ship Windows installers. The Navigator window ran its GitHub sign-in, sign-in status, repository list, and clone helpers by spawning the bundled `ok.cmd` batch wrapper directly, and Node refuses to spawn a `.cmd` or `.bat` file without a shell (its CVE-2024-27980 mitigation). The same operations from a project window went through the detached server, which already spawned the Electron binary as Node, so they worked.

Desktop now hands those helpers what the wrapper would have run: `OpenKnowledge.exe` with `ELECTRON_RUN_AS_NODE=1` on the bundled `cli.mjs`, with `NODE_OPTIONS` moved aside to `OK_NODE_OPTIONS` exactly as `ok.cmd` does. No shell is involved, so clone URLs and target paths are never interpreted by `cmd.exe`. macOS and Linux keep spawning their executable `ok.sh` wrapper.

A helper spawn that throws synchronously now resolves as a normal failed run with the error text in stderr instead of escaping the IPC handler, so a future failure of this shape lands in the desktop log rather than only in the renderer console.

Three of these changes reach every platform, not just Windows. Cancelling a GitHub sign-in or a repository clone now ends the run quietly instead of reporting it as a failure. Error text from a failed sign-in or clone is scrubbed before it is shown or written to the log: a GitHub token is redacted, and a home directory inside a path is shortened to `~`, so a clone that stops because the folder already exists now reads `~/Documents/repo` rather than your full home path. And if a second sign-in starts while one is already running, the first one now ends with a message saying it was replaced, instead of leaving its dialog counting down a device code that is no longer being polled.
