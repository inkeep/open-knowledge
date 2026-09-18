---
"@inkeep/open-knowledge": patch
---

`ok config migrate` no longer leaves an empty parent behind. Clearing the last key under a mapping wrote back a husk — `bridge: {}` once the retired bridge switches were stripped — which validates but leaves a dead stanza in your config file.
