---
"@inkeep/open-knowledge": patch
---

Fixed symbolic links (mode `120000`) being automatically staged as deleted in the background Git sync loop. The filesystem scanner now correctly walks and includes symbolic links inside the content directory so they are recognized as on-disk files and are not incorrectly removed from Git tracking during sync commits.
