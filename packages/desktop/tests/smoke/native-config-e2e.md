# native-config packaged-load smoke — runbook

**Purpose.** Verify US-010 AC5 — the prebuilt `native-config` (`toml_edit`) addon that the CLI bundles into `dist/native/` actually loads and round-trips from the shipped layout: the npm CLI tarball, and the packaged macOS `.app`/`.dmg`.

**What is committable + automated vs. deferred.**

| Check | Fidelity | Where |
|---|---|---|
| Bundle is produced + loadable + round-trips (parse / upsert / symlink) from `packages/cli/dist/native/` | Real (runs in `pnpm check`) | `packages/desktop/tests/unit/verify-native-config-driver.test.mjs` (end-to-end test) |
| Driver maps `.dmg`/`.app`/dir inputs + exit codes | Real (unit) | same test file |
| Loads from a packaged `.app`/`.dmg` shipped layout | Real, but needs a built artifact | this runbook, Step 2 (`verify-native-config-in-packaged-dmg.mjs`) |
| Loads **in the Electron main process** (hardened runtime + asar) | Deferred to signed-DMG QA | this runbook, Step 3 |

The addon is pure computation over a napi N-API surface that is ABI-stable across Node and Electron, so the Node-load checks (Steps 1–2) are a faithful proof of the bundle + layout + loadability. Step 3 (the in-Electron-process confirmation) is the only part that genuinely needs a packaged runtime, and it is gated on a built DMG.

---

## Step 1 — Pre-package (creds-free, runs in CI)

```bash
pnpm build                                       # turbo builds native-config -> cli; copies into dist/native
node scripts/verify-native-config-in-packaged-dmg.mjs packages/cli/dist
# Expect: "verify-native-config: OK — backend=native nativeDir=.../dist/native durationMs=N" and exit 0
```

`pnpm check` runs the same load end-to-end via the driver test, so a regression that breaks the bundle (a missing `build:native` step, a `type: module` collision, a missing `package.json` in `dist/native/`) fails the gate.

Exit codes: `0` loaded + round-tripped · `1` found but failed to load · `2` bad args · `3` no `dist/native` loader found.

---

## Step 2 — Packaged artifact (a built `.app` or `.dmg`)

After an unsigned or signed build, point the driver at the artifact:

```bash
pnpm --dir packages/desktop run build:mac:unsigned
node scripts/verify-native-config-in-packaged-dmg.mjs \
  packages/desktop/dist-desktop/OpenKnowledge-arm64.dmg
# Expect: "verify-native-config: OK — backend=native ..." and exit 0
```

The driver mounts the DMG read-only, copies the first `.app`, detaches, and loads `Contents/Resources/cli/dist/native/index.js` under Node. A non-zero exit means the bundle did not ship into the `.app` — check the electron-builder `from: ../cli/dist` rule and `cli` build output.

---

## Step 3 — In-Electron-process confirmation (deferred — needs a built DMG)

The Node-load checks above do not exercise the Electron main process's own resolution path. To confirm the addon loads in-process inside the packaged app:

1. Launch the packaged app from `/Applications/`.
2. Open a project so the MCP repair sweep runs (it loads the addon in-process via `writeUserMcpConfigs -> getTomlConfigEngine`).
3. Register OK into a Codex `~/.codex/config.toml` containing a comment + a 64-bit integer; confirm the comment + value survive (format-preserving write = the native engine ran). If the comment is stripped/reflowed, the desktop main fell back to the JS path — investigate `app.asar.unpacked/node_modules/@inkeep/open-knowledge-native-config` and the `dist/native` bundle.

This step needs a built (ideally signed) DMG and a real Codex install, so it runs at release/QA time, not in the per-PR gate. The non-destructive fallback (D11) keeps a missing/failed addon safe — Codex registration simply degrades, never corrupts — so a Step-3 miss is a fidelity regression, not a data-loss one.

---

## Related

- [`scripts/verify-native-config-in-packaged-dmg.mjs`](../../../../scripts/verify-native-config-in-packaged-dmg.mjs) — the driver.
- [`packages/desktop/tests/unit/electron-builder-cli-native-deps.test.ts`](../unit/electron-builder-cli-native-deps.test.ts) — asserts the bundle + per-package copies ship.
- [`packages/desktop/tests/smoke/keyring-e2e.md`](./keyring-e2e.md) — the signed-DMG keyring runbook this mirrors.
- `reports/native-addon-npm-distribution/REPORT.md` — why the binaries are bundled into the CLI tarball (Option 3).
