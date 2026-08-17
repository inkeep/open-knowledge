---
'@inkeep/open-knowledge': patch
---

For fresh PATH setups, the desktop app now adds the `ok` command to Fish only when Fish is the login shell or has independent usage or configuration evidence. New Zsh and Bash setups no longer create an unused Fish configuration file; files recorded by older installs remain available to Settings and `ok uninstall` for cleanup.
