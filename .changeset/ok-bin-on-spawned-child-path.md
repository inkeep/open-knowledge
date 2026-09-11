---
"@inkeep/open-knowledge": patch
---

CLIs installed in `~/.ok/bin` are now found and launchable even when the shell PATH block was declined or deleted.

On macOS and Linux (packaged builds, not AppImage runs), OpenKnowledge creates `~/.ok/bin` and puts its own `ok` command there whether or not you let it edit your shell startup files, and the built-in terminal already ran with that directory on its PATH. The checks that decide whether a CLI is installed did not. A tool sitting in `~/.ok/bin` therefore read as missing, so Settings offered install instructions for a command the app could already run, and the toolbar control that would have launched it stayed hidden. Slidev was the reported case. Claude, Codex, and every other terminal CLI were affected the same way.

The presence checks, the Slidev launch, and the CLI launches the built-in terminal starts for you now compose their child environment through the same helper, so all three put the same OK-managed directory first on their child's PATH. All three also reassert that directory after your startup files have run, so a startup file that replaces PATH can no longer hide the installed command. The reassert skips the directory when it is already there, matching the rule the environment layer follows, so it appears once rather than twice and your own PATH ordering is left alone. Commands you type yourself in the terminal are not reasserted and keep your PATH exactly as your startup files left it.

Presence checks and global Slidev launches now run the same shell mode as the built-in terminal. On macOS that is a login interactive shell, unchanged. On Linux it is an interactive shell, which is what the terminal already used and what the desktop convention expects, so a `slidev` shell function or alias defined in `~/.bashrc` is now both detected and launchable rather than detected and then failing with `command not found`.

The tradeoff on Linux is that a global deck launch is no longer a login shell, so anything set only in your shell's login-only startup files (a proxy, a `JAVA_HOME`, a version manager init) no longer reaches the deck. For `bash` those are `/etc/profile`, `/etc/profile.d/`, `~/.profile` and `~/.bash_profile`, and for `zsh` they are `/etc/zprofile` and `~/.zprofile`. Move the setting to the file your shell reads for every interactive session, `~/.bashrc` for `bash` or `~/.zshrc` for `zsh`, if your deck's toolchain needs it.

Global Slidev launches also disable shell job control before starting the deck, so closing a slides window reliably stops the dev server instead of leaving it running and holding its port. POSIX shells get `set +m` and `fish` gets `status job-control none`, both emitted after your startup files have run so a startup file cannot turn job control back on. A `fish` deck was already contained at fish's default job-control mode, but a `config.fish` that sets `status job-control full` took that away, and the opt-out now covers that case too.

A CLI-presence check and a Slidev dev server are no longer told they are the OpenKnowledge terminal. Launching the app from inside the built-in terminal used to pass that marker down to them, which made agent skills treat a probe or a preview server as a hosted agent session. The terminal itself still carries the marker.

Windows never had the reported bug: there the installer puts the CLI on your PATH itself rather than through a `~/.ok/bin` shim, so those checks already saw it. Windows does pick up two changes from the same work. The presence checks now run with the app's own bundled CLI directory ahead of the PATH they inherit, and the Slidev launch now writes its composed PATH under the variable name Windows actually uses, instead of adding a second, empty one beside it.
