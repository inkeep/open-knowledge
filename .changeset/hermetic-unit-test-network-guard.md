---
---

No release. This branch is test infrastructure: a shared vitest setup file that
refuses non-loopback `fetch`, a contract test that imports every vitest project
and checks its resolved `setupFiles`, and the test-side fixes for the reaches the
guard exposed.

The one production edit is additive and inert by default. `ServerOptions` and
`BootServerOptions` gain an optional `acpRegistryFetchImpl`, forwarded to
`AcpRegistry`, which already accepted a `fetchImpl` and defaults to global
`fetch`. With the option unset every code path is byte-identical to before, so
there is no user-visible behaviour to describe in a release note.
