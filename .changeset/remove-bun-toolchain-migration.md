---
"@inkeep/open-knowledge": patch
---

Migrate the build, test, and CI toolchain from Bun to pnpm 10 and Vitest 4.

This is an internal toolchain migration with no runtime behavior change for the
published CLI: it still runs on Node (`engines.node >= 24`, shebang
`#!/usr/bin/env node`). The workspace is now a standard pnpm workspace
(`pnpm-workspace.yaml` + `pnpm-lock.yaml`), all five test tiers run under Vitest
via a `bun:test` compatibility shim and a `Bun.*` facade, and every TypeScript
entry point runs through Node + `tsx`. `bun.lock`, `bunfig.toml`, and
`.bun-version` are removed, and the public mirror ships pnpm.

Bun-specific fences retired as part of the cutover:

- `findBunLockMetadataDrift` and the `bun.lock` metadata-drift guard (the pnpm
  frozen-lockfile check supersedes it).
- `check:bun-run-fallthrough` (the `bun run` PATH-fallthrough guard) and its
  test, along with the `run-bun-if-available.sh` root fan-out wrapper.
- `bun-install-ci.sh`, the retry/idle-timeout install wrapper that existed to
  work around a Bun install-hang issue; pnpm's install path replaces it.
- The `run-test-dom.sh` `--isolate` mock-leak mitigation (the per-file
  fresh-module-registry workaround for a Bun `mock.module` in-place-patch leak);
  the DOM tier is now a dedicated Vitest project with `isolate: true`.

Two small, required behavioral deltas ride along with the swap: `ok diagnose
--redact` bundles now derive doc-name redaction tokens with sha256 instead of
BLAKE2b-256 (Node's OpenSSL rejects BLAKE2 `outputLength`), so the `doc:<hex>`
tokens differ while the in-bundle inverse map still resolves them; and the
file-copy API now returns HTTP 409 for `ERR_FS_CP_DIR_TO_NON_DIR` /
`ERR_FS_CP_NON_DIR_TO_DIR` (previously an unhandled 500).
