---
"@inkeep/open-knowledge": patch
---

The Linux desktop build now also produces an `.rpm` package, so Fedora, RHEL, and other RPM-based distributions can install OpenKnowledge with their own package manager instead of unpacking a `.deb` by hand. The `.rpm` installs the same way the `.deb` does — it puts the app in the launcher, registers the `openknowledge://` links, and puts the `ok` command on your PATH — and it declares its system library requirements under their Fedora/RHEL names so the package manager pulls in anything missing. Both x86_64 and aarch64 packages are built.
