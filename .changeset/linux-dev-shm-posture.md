---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Linux desktop: avoid blank startup windows caused by a small `/dev/shm` when the temporary filesystem has enough free space. This affects Linux environments with constrained shared-memory mounts, including some containers and minimal VMs.

When `/dev/shm` has less than 512 MiB available, OpenKnowledge moves Chromium's shared memory to its temporary directory only if that destination has at least 512 MiB free. The temporary directory follows Chromium's Linux rules: `TMPDIR`, or `/tmp` when unset or empty. Hosts with sufficient shared memory keep using `/dev/shm`.

If both filesystems are too small, startup can still remain blank: free space on the temporary filesystem or configure the `/dev/shm` tmpfs mount with `size=1G`. For Docker containers, use `--shm-size=1g` when starting the container. The desktop log now records the selected location, available space, thresholds, measurement errors, and show-gate warnings so diagnostic bundles include the startup evidence.
