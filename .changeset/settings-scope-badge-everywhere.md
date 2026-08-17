---
'@inkeep/open-knowledge': patch
---

Every settings section heading now says where its values are stored. The scope badge that plugin panels already carried is on all of them, with a third value for per-machine settings: User (your user config, personal to this device), Project (committed to config.yml and shared through git), and This machine (stored in .ok/local for this project on this computer only). Hovering or focusing a badge explains the storage location in full. Descriptions that existed only to state scope have been trimmed, since the badge now carries it.
