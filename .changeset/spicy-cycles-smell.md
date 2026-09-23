---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Make renderer and Utility-process crashes diagnosable from a bug report bundle. Desktop logs now retain low-rate process memory and CPU samples, per-window liveness and lifecycle events, and the last pre-crash plus live process snapshots on each crash breadcrumb.
