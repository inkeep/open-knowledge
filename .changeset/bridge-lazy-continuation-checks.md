---
"@inkeep/open-knowledge": patch
---

Fix spurious bridge warnings and re-derive churn on documents containing CommonMark lazy continuations.

Documents whose markdown carries a lazy continuation — an unindented wrapped line inside a list item, a paragraph glued directly under a list's last bullet, or a blockquote continuation without the `> ` prefix — previously emitted recurring `bridge-invariant-violation` (tolerance-class `untracked`) and `bridge-split-brain-rederive` warnings, re-derived the editor fragment on every settlement, and re-ran fragment reconciliation on every save, even though the document parsed correctly and no data was ever at risk.

The bridge health checks now recognize parse-equivalence: when the stored bytes and the canonical serialization parse to the same document, the resting byte difference is reported through the `bridge-tolerance-applied` channel (class `parse-equivalence`) instead of alerting, and no re-derive or reconciliation churn runs. Genuine divergences — where the editor state does not match what the stored markdown parses to — keep alerting exactly as before. Stored bytes are never rewritten; your authored lazy-continuation form stays on disk verbatim.
