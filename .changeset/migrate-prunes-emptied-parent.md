---
"@inkeep/open-knowledge": patch
---

`ok config migrate` no longer leaves an empty parent behind. Clearing the last key under a mapping wrote back a husk — `bridge: {}` once the four retired bridge switches were stripped — which validates clean but keeps a dead stanza in a hand-written file. Deleting a key now removes any ancestor the delete emptied, stopping at the first one that still holds something.
