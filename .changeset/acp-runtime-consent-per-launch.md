---
'@inkeep/open-knowledge': patch
---

Ask about downloading a managed Node.js/uv runtime once per launch instead of remembering the answer.

The consent prompt used to carry a "Remember this for future agents" checkbox that defaulted to on, and the decision was persisted to `~/.ok/acp-runtime-consent.json`. A remembered "Not now" removed the offer permanently with nothing in the UI to undo it — the only cure was deleting that file by hand. A remembered "Download" authorized a later download the user never saw.

The prompt is now per launch: decline, and the next agent that needs the runtime asks again. An already-installed runtime is still used without asking, which is what made the remembered grant near-dead weight anyway. Any existing `acp-runtime-consent.json` is simply ignored — nothing reads or writes it now, and leaving it costs nothing.
