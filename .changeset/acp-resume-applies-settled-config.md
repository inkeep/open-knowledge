---
"@inkeep/open-knowledge": patch
---

Agent thread settings now survive archiving and resuming. Picking up an archived conversation started a fresh agent session on the agent's own defaults, so a thread you had set to a particular model quietly went back to answering on a different one while the settings menu still showed your choice. The settled model, reasoning effort, and mode are now captured before the resume response overwrites them and re-applied to the new session, in the same order a new thread applies them, so an option the agent has since retired is skipped rather than failing the resume. An agent that resumes without reporting its configuration is re-sent the values rather than trusted, since in that case the cached ones describe the session that ended.

Changing a setting on an archived conversation also works now instead of being silently dropped. There is no agent to apply it to yet, so the choice is recorded against the thread and applied to the session the resume starts, and the menu says so rather than leaving a pick that appears to have done nothing.
