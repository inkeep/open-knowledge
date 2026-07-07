---
"@inkeep/open-knowledge": patch
---

Typing into a document that carries organic markdown forms (like a list whose next paragraph starts without a blank line) no longer emits spurious `bridge-split-brain-rederive` telemetry on space keystrokes. The bridge health check now treats trailing line whitespace — a byte shape the serializer already declares insignificant — as the documented normalization it is, while genuine divergence keeps failing loud. Keystroke-granularity coverage (per-character transactions, zero-gap bursts, two-peer concurrent typing) is now part of the integration and fuzz suites.
