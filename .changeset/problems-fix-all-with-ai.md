---
"@inkeep/open-knowledge": patch
---

The Problems panel now offers a **Fix all with AI** button beside the deterministic fixer, in both the document and project scopes. It hands the whole scope to your preferred AI agent as one instruction, pointing it at the `audit` tool for the current list of lint violations and broken links and at `lint` with `fix: true` for the mechanically-fixable subset, so the agent reads live truth rather than a snapshot taken when you clicked.

The deterministic button is now labelled **Auto-fix** rather than "Fix all", and both buttons explain themselves on hover. Previously a document whose problems had no automatic fix showed a single disabled "Fix all" with nothing to say for itself, which read as a bug rather than as "these need judgement"; now the AI action sits next to it, enabled, and the disabled Auto-fix says why it is off.
