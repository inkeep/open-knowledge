---
"@inkeep/open-knowledge": patch
---

Fix: the first-run onboarding card now appears when you start a project from a starter pack, not just from a blank project. A starter pack seeds content at create time, which previously made the card's "fresh project" check treat the project as already-established and stay hidden. The card now keys off the first-run create-new flow, so both blank and starter-pack projects get onboarding — while opening a pre-existing populated folder still correctly stays quiet.

Also fixed: on a starter-pack project the "Create your first file" step no longer auto-completes from the pack's seeded templates. The step now baselines the entry count at activation and completes only when you author a document beyond the seed, so the checkmark reflects an action you actually took.
