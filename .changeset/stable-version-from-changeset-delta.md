---
"@inkeep/open-knowledge": patch
---

Stable releases are now versioned as a single semantic-version bump over the previous stable, derived from the changeset delta between them, instead of stripping the `-beta.N` suffix from the promoted beta tag. Accumulated patch work now ships as its own patch (for example `0.30.1 → 0.30.2`) rather than collapsing an entire beta cycle to one stable, and a minor changeset in the delta still bumps the minor. Promotion selection and version determination are also separated: a scheduled job selects the newest soak-proven beta, and the promote job — shared by manual and automatic promotions — computes the version.
