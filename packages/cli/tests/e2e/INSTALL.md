# Packed CLI installation

The required cli-e2e mode is `locked`. It packs the CLI from the checkout and replays its runtime graph from the committed workspace `pnpm-lock.yaml`, using the workspace package-manager pin. A temporary consumer retains the lock's package records, integrity, peer snapshots, platform metadata and patches. The consumer lock is generated for the run; it is not another maintained lockfile.

Set `OK_CLI_E2E_INSTALL_MODE=fresh` to use npm's native fresh resolution with the same product assertions. Fresh mode deliberately retains npm's optional-dependency tolerance. Only fatal npm acquisition failures are classified as unavailable; strict complete acquisition applies to locked mode.

Fresh mode writes npm's generated package-lock JSON to `packages/cli/test-results/cli-e2e-fresh-graph.json`, relative to the Open Knowledge workspace. The ignored artifact is replaced each run. It records resolution, including optional declarations and resolved package records. An optional version missing during resolution has no package record, but npm can retain the resolved record after dropping a package whose tarball failed. The artifact therefore cannot identify every optional package absent from disk.

## Acquisition outcome

Installer output is printed on failure. Only classified registry or transport errors receive retries: at most three attempts share the existing 180-second acquisition budget, with installer retries disabled and request deadlines fitted inside the remaining budget. Product errors, unclassified errors and external interruption do not become unavailable outcomes. Missing packed assets remain product failures.

If all failures in a Vitest run are acquisition exhaustion, the reporter returns exit 77 and writes one stderr line beginning `INKEEP_GATE_RESULT_V1 ` followed by JSON. Any product failure keeps the ordinary failed-run result and suppresses this marker. This marker is diagnostic evidence, not an admission or successful-check result. The future gate reader and its complete shared schema belong to the gate integration.

This producer emits these fields:

| Field | Value or meaning |
| --- | --- |
| `boundary` | `round` |
| `class` | `not-run` |
| `exit` | `77` |
| `signal` | `null`; an external signal does not emit this marker |
| `outputBytes` | Captured installer stdout and stderr bytes across attempts, summed once per acquisition failure even if Vitest propagates that error more than once |
| `runId` | A UUID for this emitted run result |
| `head` | The checked-out Git commit; valid `GITHUB_SHA` is a fallback when Git lookup is unavailable |
| `base` | `pull_request.base.sha` or `merge_group.base_sha` from `GITHUB_EVENT_PATH`; an explicit `GITHUB_BASE_SHA` is a fallback comparison input |
| `subject` | `cli-e2e` |
| `step` | `packed-install` |
| `reasonCode` | `registry-unavailable` |

`head` identifies the tree tested, which can be a pull-request merge commit. It does not claim to be the pull-request source commit. Unknown provenance is explicitly `null`: unavailable checkout identity or invalid comparison metadata also produces a separate diagnostic. A run without a comparison input has `base: null`. Metadata lookup cannot replace a confirmed acquisition outcome with a reporter exception. A consumer must not treat missing provenance as permission to admit a change.

## Focused checks

From the Open Knowledge workspace:

```sh
pnpm --dir packages/cli exec vitest run tests/e2e/packed-install.test.ts tests/e2e/install-outcome.test.ts tests/e2e/install-deadline.test.ts --reporter=verbose --maxWorkers=2
```

These checks use real npm and pnpm against an owned loopback registry. Deadline classification tests inject a clock and installer result without delivering signals. These focused files run in the CLI package's default `test` tier in CI. The cli-e2e job runs `pnpm --dir packages/cli test:e2e:cli`, which selects only `tests/e2e/cli-linux-e2e.ts` and drives the packed CLI's product journeys.
