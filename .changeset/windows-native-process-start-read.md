---
"@inkeep/open-knowledge": patch
---

On Windows, `ok uninstall` and `ok deinit` read the live process creation time through the native addon instead of launching PowerShell. Cleanup continues to refuse a reused or unverifiable PID. POSIX process checks retain `ps`.

A Windows addon that is missing, unusable, or unable to complete the query refuses removal without a PowerShell fallback, and the refusal names the action for the fault it hit: reinstall OpenKnowledge when the component could not be loaded, or rerun from an account that can inspect the process when the component loaded and Windows refused the query, where reinstalling would not help. Either way you can stop the server yourself and confirm it exited. The failure detail is recorded in `~/.ok/logs` rather than printed.
