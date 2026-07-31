---
"@inkeep/open-knowledge": patch
---

Stopped building the Linux AppImage. Its launcher requires FUSE 2, which current mainstream distributions no longer ship, so the file failed to start out-of-the-box on stock systems (verified on Debian 13, both architectures). Linux ships as a `.deb`; updates will be delivered through the system package manager (apt repository), and the in-app auto-updater is now disabled on Linux accordingly. Users without install rights can use the npm CLI or the web app.
