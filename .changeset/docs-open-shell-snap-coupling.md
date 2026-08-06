---
'@inkeep/open-knowledge': patch
---

Gate the F0 shell-snap e2e on a contention-invariant coupling ratio instead of a fixed millisecond budget. The old `shellMs < 500` assertion encoded "finishes within 500ms on whatever machine runs it" as a stand-in for "the shell is decoupled from editor mount cost" — those coincide only while runner speed is constant, and the constant had eroded from 1.9x local-healthy to ~0.99x CI-healthy, so it reddened on correct code.
