---
"@inkeep/open-knowledge": patch
---

Fixed a false "your update didn't install" notice that could appear while the update was in fact still installing. A beta-to-beta bump within the same version number, committed by a quit that no live process observed, lost the only timestamp the app had for when the install began, so the next launch judged a healthy install as failed. The app now keeps that timestamp across its own boot-time bookkeeping and holds the verdict until the install has really had its chance.
