---
"@inkeep/open-knowledge": patch
---

`bridge.lossDetector` joins the deprecated `bridge:` settings, and the derive-loss reporter it gated is gone.

The previous release documented `bridge.deferGuard`, `bridge.fixedPoint` and `bridge.preDrain` as accepted-but-unread. `bridge.lossDetector` is now in the same position and its description says so. It gated the construction of the markdown bridge's derive-loss reporter, whose only caller was the paired agent-undo derive; that path went away with the bridge, so the reporter was being built and handed to every agent session without anything ever invoking it. The setting still parses and still validates, so no upgrade step is required, and it was already having no effect before this release — the description change makes that visible where you read it rather than changing behaviour.

Loss detection itself is unaffected and was never routed through this setting. Persistence still checks every reconciliation for dropped content, still writes a recovery checkpoint when it finds any, and still records a content-free event in the loss-capture ring; `lossCapture.enabled` continues to control that ring and remains a live setting, as do `bridge.backgroundThrottle` and `bridge.flushOnHide`.
