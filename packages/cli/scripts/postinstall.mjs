#!/usr/bin/env node
/**
 * `@inkeep/open-knowledge` postinstall hook.
 *
 * Fires `installUserSkill()` once per `npm install` / `bun install` / `npx`
 * cache population. Non-fatal: any failure is swallowed so the host install
 * never blocks.
 *
 */

async function run() {
  let installUserSkill;
  try {
    // Relative import resolves inside the published npm tarball at
    // <pkg-root>/dist/index.mjs — the tsdown-bundled entry that re-exports
    // `installUserSkill` from @inkeep/open-knowledge-server.
    const mod = await import('../dist/index.mjs');
    installUserSkill = mod.installUserSkill;
  } catch {
    // Dev-install scenarios (e.g. running `npm install` against a tarball
    // where dist/ is missing, `--ignore-scripts`, or source-only installs)
    // never block — fall through to exit 0.
    return;
  }

  if (typeof installUserSkill !== 'function') return;

  let result;
  try {
    result = await installUserSkill();
  } catch {
    // installUserSkill is documented as never-throws; this catch is pure
    // defensive hardening so a broken build never blocks `npm install`.
    return;
  }

  if (result === 'installed') {
    process.stdout.write('[open-knowledge] Agent Skill installed to detected agent hosts.\n');
  } else if (result === 'failed') {
    process.stderr.write(
      '[open-knowledge] Agent Skill auto-install failed; run manually: ' +
        "npx skills@~1.5.0 add <bundled-path> --agent '*' -g -y --copy\n",
    );
  }
  // result === 'skip-current' → silent.
}

// Fire-and-forget. Always exit 0 regardless of outcome —
// `npm install` must never fail because skill-install hit an edge case.
run().finally(() => {
  process.exit(0);
});
