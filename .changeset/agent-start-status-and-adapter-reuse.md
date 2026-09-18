---
"@inkeep/open-knowledge": patch
---

Opening, resuming, or retrying an in-app agent now reports "Starting" rather than "Installing" unless it is really fetching a catalog agent's adapter, and screen readers announce how the wait ends. That adapter now resolves once, not per conversation; retrying one that failed to start re-resolves only that agent.
