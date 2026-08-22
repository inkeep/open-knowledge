/**
 * Adversarial proof that the release gates bite, plus the ordering and payload
 * invariants a later edit is most likely to break silently.
 *
 * GitHub Actions cannot be executed locally, so the ordering assertions parse
 * the workflow's flat step list and compare positions. That is the highest
 * fidelity available for "the gate runs before the thing it gates", and it is
 * precisely the invariant a well-meaning reorder would destroy without any
 * test noticing.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { buildSlackPayload } from './build-smoke-alert-payload.mjs';
import { selectPromotion } from './select-beta-to-promote.mjs';
import { smokePackagedDmg, VERDICT } from './smoke-packaged-dmg.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const desktopRelease = read('desktop-release.yml');
const promoteStable = read('promote-stable.yml');
const releaseYml = read('release.yml');
const bugLane = read('bug-lane.yml');

/**
 * One workflow step's body, bounded at the NEXT step.
 *
 * Assertions about a step have to be scoped to that step. A whole-file
 * `toContain` passes on any occurrence, so a string that appears in two steps
 * lets either one be mutated while the other keeps the test green; a
 * fixed-width slice runs past a short step into its neighbour and does the
 * same. Both holes were shipped and caught by mutation testing rather than by
 * review, which is why this is the only way these files slice a step.
 */
const bugLaneStep = (name) => {
  const start = bugLane.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`bug-lane.yml has no step named ${name}`);
  const rest = bugLane.slice(start);
  const end = rest.indexOf('\n      - name: ');
  return end === -1 ? rest : rest.slice(0, end);
};
const selectBeta = read('select-beta-to-promote.yml');

/**
 * Ordered step names across the workflow, in FILE order. Under the fan-out
 * topology file order equals execution order only WITHIN a job; cross-job
 * ordering is enforced by the `needs:` DAG, which the dedicated describe
 * below pins directly. Fails loud rather than silently returning [] if the
 * shape ever changes.
 */
function stepNames(source) {
  const names = [...source.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());
  if (names.length < 5) {
    throw new Error(
      `step-name parse found only ${names.length} steps; the shape must have changed`,
    );
  }
  return names;
}

const indexOfStep = (names, needle) => names.findIndex((n) => n.includes(needle));

/**
 * Step-level `if:` conditions (8-space indent) with YAML block-scalar
 * folding resolved: an `if: >-` yields its joined continuation lines, not
 * the literal `>-` — which would sail through every `not.toContain` check.
 */
function stepLevelIfConditions(source) {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {8}if: (.+)$/.exec(lines[i]);
    if (!m) continue;
    let cond = m[1].trim();
    if (/^[>|][+-]?$/.test(cond)) {
      const cont = [];
      for (let j = i + 1; j < lines.length; j++) {
        const cm = /^ {10,}(\S.*)$/.exec(lines[j]);
        if (!cm) break;
        cont.push(cm[1].trim());
      }
      cond = cont.join(' ');
    }
    out.push(cond);
  }
  return out;
}

describe('the stable gate is upstream of everything that ships', () => {
  const names = stepNames(desktopRelease);

  test('the smoke gate runs after the DMG is built', () => {
    // Both steps live in build-macos, so file order is execution order here.
    const build = indexOfStep(names, 'Build + sign + notarize DMG/ZIP');
    expect(build).toBeGreaterThan(-1);
    expect(indexOfStep(names, 'Smoke the packaged DMG')).toBeGreaterThan(build);
  });

  test('the smoke gate runs before the draft is promoted to published', () => {
    const smoke = indexOfStep(names, 'Smoke the packaged DMG');
    const promote = indexOfStep(names, 'Promote draft release to published');
    expect(smoke).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(promote);
  });

  test('the smoke gate runs before the publish-stable dispatch, so npm cannot move first', () => {
    const smoke = indexOfStep(names, 'Smoke the packaged DMG');
    const npm = indexOfStep(names, 'Trigger release.yml to publish stable to npm');
    expect(npm).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(npm);
  });

  test('the smoke gate runs before both release announcements', () => {
    const smoke = indexOfStep(names, 'Smoke the packaged DMG');
    expect(smoke).toBeLessThan(indexOfStep(names, 'Announce stable release to Slack'));
    expect(smoke).toBeLessThan(indexOfStep(names, 'Announce stable release to Discord'));
  });

  test('no shipping STEP opts out of the implicit success() guard', () => {
    // A downstream step carrying `if: always()` / `!cancelled()` would run
    // even after the gate refused — which is exactly how a gate stops
    // gating. JOB-level `!cancelled()` predicates are a different animal:
    // the required-platforms valve needs them, and each one re-asserts the
    // success of everything it actually gates on — they are pinned exactly
    // in the fan-in DAG describe below. Step-level ifs sit at 8-space
    // indentation; job-level at 4.
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('- name: Alert on a blocked release'));
    const stepIfs = stepLevelIfConditions(shipping);
    expect(stepIfs.length).toBeGreaterThan(0);
    for (const condition of stepIfs) {
      expect(condition, `step-level if opts out of success(): ${condition}`).not.toContain(
        'always()',
      );
      expect(condition, `step-level if opts out of success(): ${condition}`).not.toContain(
        '!cancelled()',
      );
    }
  });

  test('every shipping step with an explicit if: spells success() itself', () => {
    // The subtler sibling of the test above, and the one that matters more.
    // Actions injects the implicit `success()` ONLY on steps with no `if:`;
    // declare one and you own the whole predicate. A shipping step whose `if:`
    // omits `success()` fires on a job that already failed — which is a gate
    // that does not gate. This escaped review once: the npm dispatch shipped
    // with a channel-and-event `if:` and no `success()`, so a refused DMG
    // would still have published to npm.
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('- name: Alert on a blocked release'));
    // Step-level ifs only (8-space indent, folding resolved) — job-level
    // predicates are the required-platforms valve, pinned in the fan-in
    // DAG describe.
    const conditions = stepLevelIfConditions(shipping);
    // One condition in this span is a gate, not shipping: the smoke gate's
    // own channel scope. Everything else ships and must be success()-gated.
    const shippingConditions = conditions.filter(
      (c) => c !== "steps.channel.outputs.channel == 'latest'",
    );
    expect(shippingConditions.length).toBeGreaterThan(0);
    for (const condition of shippingConditions) {
      expect(condition, `shipping step condition lacks success(): ${condition}`).toContain(
        'success()',
      );
    }
  });
});

describe('the Azure signing flag set satisfies the schema', () => {
  test('every schema-required azureSignOptions field is passed by both Windows packagers', () => {
    // app-builder-lib's validateConfig rejects a PARTIAL azureSignOptions
    // before packaging anything ("should be one of these: null"), and the
    // fan-in topology turns that one-job failure into a zero-platform
    // release. The required set is data (scheme.json), so pin the workflows'
    // flag sets against it — this is exactly the check that would have
    // caught the three-of-four-fields shape without a live Azure account.
    // Resolution goes through electron-builder's own tree because pnpm's
    // isolated layout hides transitive deps from the workspace packages.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const desktopRequire = createRequire(join(repoRoot, 'packages/desktop/package.json'));
    const ebMain = desktopRequire.resolve('electron-builder');
    const ablRequire = createRequire(ebMain);
    const ablMain = ablRequire.resolve('app-builder-lib');
    const scheme = JSON.parse(readFileSync(join(dirname(ablMain), '..', 'scheme.json'), 'utf8'));
    const required = scheme.definitions.WindowsAzureSigningConfiguration.required;
    expect(required.length).toBeGreaterThanOrEqual(3); // schema sanity, not vacuous

    for (const workflow of [desktopRelease, read('desktop-build-win-linux.yml')]) {
      const passed = [...workflow.matchAll(/--config\.win\.azureSignOptions\.([A-Za-z]+)=/g)].map(
        (m) => m[1],
      );
      for (const field of required) {
        expect(passed, `workflow is missing schema-required azureSignOptions.${field}`).toContain(
          field,
        );
      }
    }
  });
});

describe('the fan-in publication DAG gates every platform', () => {
  test('publish-assets waits on all four build jobs', () => {
    // The single publication point must sit downstream of EVERY packaging
    // job — dropping one from `needs` publishes a release that platform
    // never built for.
    expect(desktopRelease).toContain(
      'needs: [prepare, build-macos, build-windows, build-linux]',
    );
  });

  test('finalize waits on publish-assets (and the smoke via build-macos)', () => {
    expect(desktopRelease).toContain('needs: [prepare, build-macos, publish-assets]');
  });

  test('no electron-builder invocation publishes; only the fan-in touches the Release', () => {
    expect(desktopRelease).not.toContain('--publish always');
    const invocations = [...desktopRelease.matchAll(/electron-builder --\w+/g)];
    expect(invocations.length).toBeGreaterThanOrEqual(3);
    expect(desktopRelease).toContain('gh release upload "$RELEASE_TAG"');
  });

  test('the inventory is asserted before upload and re-verified after', () => {
    const names = stepNames(desktopRelease);
    const assert = indexOfStep(names, 'Assert the complete cross-platform inventory');
    const upload = indexOfStep(names, 'Upload assets to the GitHub Release');
    const verify = indexOfStep(names, 'Verify the Release carries the full inventory');
    expect(assert).toBeGreaterThan(-1);
    expect(assert).toBeLessThan(upload);
    expect(upload).toBeLessThan(verify);
  });

  test('the required-platforms valve gates exactly what it may skip — and mac has no bypass', () => {
    // publish-assets may proceed past a FAILED platform only when that
    // platform is absent from the required set; the mac result is asserted
    // unconditionally (the stable smoke gate rides on build-macos), and
    // prepare refuses a required-set that omits mac at the variable level.
    const pa = desktopRelease.slice(
      desktopRelease.indexOf('\n  publish-assets:'),
      desktopRelease.indexOf('\n  finalize:'),
    );
    expect(pa).toContain("needs.build-macos.result == 'success'");
    expect(pa).toContain(
      "needs.build-windows.result == 'success' || !contains(needs.prepare.outputs.required, 'windows')",
    );
    expect(pa).toContain(
      "needs.build-linux.result == 'success' || !contains(needs.prepare.outputs.required, 'linux')",
    );
    expect(pa).not.toContain("contains(needs.prepare.outputs.required, 'mac')");
    // The valve is DEAD without !cancelled(): a non-required platform's
    // failure would skip these jobs via the implicit all-needs-success
    // default, blocking exactly the release the override exists to save.
    expect(pa).toContain('!cancelled()');
    const fin = desktopRelease.slice(
      desktopRelease.indexOf('\n  finalize:'),
      desktopRelease.indexOf('\n  alert:'),
    );
    expect(fin).toContain('!cancelled()');
    expect(fin).toContain("needs.publish-assets.result == 'success'");
    expect(fin).toContain("needs.build-macos.result == 'success'");
    // Fail-CLOSED shape, not just message presence: the mac guard must be
    // the ::error:: + exit 1 pair (a downgrade to ::warning:: or a dropped
    // exit would leave mac silently droppable).
    expect(desktopRelease).toMatch(
      /::error::DESKTOP_RELEASE_REQUIRED_PLATFORMS must include 'mac'[^"]*"\s*\n\s*exit 1/,
    );
  });

  test('the alert pages on a blocked RELEASE, not on any failed job', () => {
    // Under a degraded required-set a non-required platform can fail while
    // the release still publishes — paging on that would train readers to
    // ignore the alert. finalize != success covers every blocked shape
    // transitively.
    const alertJob = desktopRelease.slice(
      desktopRelease.indexOf('\n  alert:'),
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alertJob).toContain("needs.finalize.result != 'success'");
    expect(alertJob).not.toContain('if: failure()');
  });
});

describe('the moved dispatch keeps the contract release.yml consumes', () => {
  test('promote-stable no longer dispatches publish-stable', () => {
    expect(promoteStable).not.toContain('event_type: "publish-stable"');
    expect(desktopRelease).toContain('event_type: "publish-stable"');
  });

  test('the event type is exactly what release.yml listens for', () => {
    expect(releaseYml).toContain('types: [publish-stable]');
    expect(desktopRelease).toContain('{event_type: "publish-stable", client_payload:');
  });

  test('the payload carries the same three field names release.yml reads', () => {
    const dispatch = desktopRelease.slice(
      desktopRelease.indexOf('- name: Trigger release.yml to publish stable to npm'),
    );
    const payload = dispatch.slice(dispatch.indexOf('jq -nc'), dispatch.indexOf('gh api -X POST'));
    for (const field of ['ref: $ref', 'version: $version', 'dispatched_by: $by']) {
      expect(payload).toContain(field);
    }
    // And release.yml still reads each of them.
    expect(releaseYml).toContain('github.event.client_payload.ref');
    expect(releaseYml).toContain('github.event.client_payload.version');
    expect(releaseYml).toContain('github.event.client_payload.dispatched_by');
  });

  test('the dispatch is gated so beta cuts and manual re-runs never publish npm', () => {
    const dispatch = desktopRelease.slice(
      desktopRelease.indexOf('- name: Trigger release.yml to publish stable to npm'),
      desktopRelease.indexOf('# The on-site changelog'),
    );
    expect(dispatch).toContain("needs.prepare.outputs.channel == 'latest'");
    expect(dispatch).toContain("github.event_name != 'workflow_dispatch'");
  });
});

describe('a non-pass verdict keeps a beta off the fast tier', () => {
  const meta = {
    isDraft: false,
    publishedAt: '2026-07-28T11:00:00Z', // 1h old — under-soaked
    assets: [{ name: 'x.dmg' }, { name: 'beta-mac.yml' }],
  };
  const soaked = { ...meta, publishedAt: '2026-07-25T11:00:00Z' };
  const NOW = Date.parse('2026-07-28T12:00:00Z');

  const decide = (smokeVerdict) =>
    selectPromotion({
      betaTags: ['v1.0.0-beta.2', 'v1.0.0-beta.1'],
      isAlreadyShipped: () => false,
      fetchReleaseMeta: (t) => (t === 'v1.0.0-beta.2' ? meta : soaked),
      soakSeconds: 86400,
      nowMs: NOW,
      qualifiesForFastTier: () => true,
      smokeBeta: () => smokeVerdict,
    });

  test('pass promotes early; fail and error both fall back to the 24h tier', () => {
    expect(decide('pass')).toEqual({ kind: 'select', target: 'v1.0.0-beta.2', tier: 'fast' });
    for (const bad of ['fail', 'error']) {
      expect(decide(bad)).toEqual({ kind: 'select', target: 'v1.0.0-beta.1', tier: 'soak' });
    }
  });
});

describe('a deliberately broken DMG never reads as a pass', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ok-broken-dmg-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test('a file that is named .dmg but is not one yields a non-pass verdict', async () => {
    // No mocks anywhere below this line: the real driver, the real mount
    // helper, the real filesystem. On macOS hdiutil refuses the garbage file;
    // on Linux hdiutil does not exist. Both are infrastructure, so both are
    // `error` — and the point of the test is that neither is ever `pass`.
    const fake = join(scratch, 'NotReallyOpenKnowledge.dmg');
    writeFileSync(fake, 'this is not a disk image\n');

    const result = await smokePackagedDmg(fake, {
      // Fail loud if the runner is somehow reached — a broken DMG must never
      // get that far.
      runPlaywright: async () => {
        throw new Error('the Playwright runner must not be reached for a broken DMG');
      },
    });

    expect(result.verdict).not.toBe(VERDICT.pass);
    expect(result.verdict).toBe(VERDICT.error);
    expect(result.reason).toContain('could not prepare the DMG');
  });
});

describe('a forced smoke failure pages Slack, not just an annotation', () => {
  const forced = {
    tag: 'v9.9.9',
    verdict: 'fail',
    reason: 'forced failure',
    runUrl: 'https://example.test/run/1',
  };

  test('the payload is produced and names the blocked release', () => {
    const slack = buildSlackPayload(forced);
    expect(slack.blocks.length).toBeGreaterThan(0);
    const s = JSON.stringify(slack);
    expect(s).toContain('RELEASE BLOCKED');
    expect(s).toContain('v9.9.9');
  });

  test('the workflow posts to the Slack webhook in addition to annotating', () => {
    const step = desktopRelease.slice(
      desktopRelease.indexOf('- name: Alert on a blocked release'),
      desktopRelease.indexOf('- name: Warn on stuck draft'),
    );
    expect(step).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    expect(step).toContain('::error::RELEASE BLOCKED');
  });
});

describe('the smoke harness comes from the workflow SHA, not the release tag', () => {
  const smokeStep = () => {
    const at = desktopRelease.indexOf('- name: Smoke the packaged DMG (FR5b)');
    expect(at).toBeGreaterThan(-1);
    const rest = desktopRelease.slice(at + 1);
    const end = rest.indexOf('      - name: ');
    return end === -1 ? rest : rest.slice(0, end);
  };

  test('the step overlays the harness from GITHUB_SHA', () => {
    // The harness is CI tooling. Read it from the release tag and a fix to the
    // copy logic can never reach an already-cut tag — and since promote-stable
    // tags the stable at the beta's SHA, every soaked beta is older than the
    // fix, so all of them stay unreleasable.
    const step = smokeStep();
    expect(step).toContain('git fetch --depth=1 origin "$GITHUB_SHA"');
    expect(step).toContain('git checkout "$GITHUB_SHA" --');
    expect(step).toContain('.github/scripts/dmg-mount.mjs');
  });

  test('the overlay cannot newly gate a ref that predates the harness', () => {
    // Order is the whole safety property: a ref with no harness must still take
    // the absent-gate exit, not get one grafted on from the default branch.
    const step = smokeStep();
    expect(step.indexOf('ref predates the harness')).toBeLessThan(
      step.indexOf('git checkout "$GITHUB_SHA" --'),
    );
  });

  test('the overlay degrades to the tag copy instead of blocking the release', () => {
    // A transient fetch failure must not turn into a refused release.
    expect(smokeStep()).toContain('::warning::Could not read the smoke harness');
  });
});

describe('the stable gate does not touch the beta cadence', () => {
  const scoped = (stepHeader) => {
    const at = desktopRelease.indexOf(stepHeader);
    expect(at).toBeGreaterThan(-1);
    return desktopRelease.slice(at, at + 500);
  };

  test('the smoke gate is stable-only', () => {
    // Betas flow through this same job. Gating them here would add 5-15 min to
    // every cadence cut and let a bad DMG block the cadence itself; the beta
    // equivalent is the selection-time gate, which runs after publication.
    expect(scoped('- name: Smoke the packaged DMG (FR5b)')).toContain(
      "if: steps.channel.outputs.channel == 'latest'",
    );
  });

  test('the alert is stable-only too, so a beta hiccup does not page', () => {
    // The failure() half of the old combined predicate moved to the alert
    // JOB header (pinned by build-smoke-alert-payload.test.mjs); the step
    // keeps the channel scope.
    expect(scoped('- name: Alert on a blocked release (FR5c)')).toContain(
      "if: needs.prepare.outputs.channel == 'latest'",
    );
  });

  test('the beta path keeps its existing stuck-draft warning', () => {
    // No step-level channel gate: the warning fires for BOTH channels (the
    // alert job's failure() header is what conditions it on a broken run).
    const warn = scoped('- name: Warn on stuck draft');
    expect(warn).toContain('RECOVERY="gh release edit');
    expect(warn).not.toContain("if: needs.prepare.outputs.channel == 'latest'");
  });
});

describe('the bug lane verifies the synthetic tree at the same bar as main', () => {
  const verify = bugLane.slice(
    bugLane.indexOf('- name: Verify the synthetic tree'),
    bugLane.indexOf('- name: Dispatch the point release'),
  );

  test('a red tier gets one retry before the tick is refused', () => {
    // Single-shot here holds a candidate to a STRICTER bar than the tier that
    // gates main, which retries each package once and treats a retry-pass as
    // green. These tiers spawn real processes (an orphaned CLI reaped on host
    // death), so one flake under runner contention refused a sound fix on
    // 2026-08-04 and the page blamed the fix for it.
    const runs = [...verify.matchAll(/turbo run typecheck test/g)];
    expect(
      runs.length,
      'verify must invoke the tiers twice: once, then one flake retry',
    ).toBe(2);
    expect(verify).toContain('elif pnpm exec turbo run typecheck test');
  });

  test('the first attempt runs to completion so the retry stays incremental', () => {
    // Load-bearing against this job's cancel window, not a style choice.
    // turbo defaults to `--continue=never`, which cancels every in-flight and
    // unstarted task on the first failure — none of those cache, so the retry
    // re-runs them and a late failure costs close to two full passes. With
    // `cancel-in-progress: true` a tick that outruns the next one is killed
    // before it can page, losing the refusal entirely.
    // Scoped to the invocation LINES, not the step text: the comment above
    // them names both flags to explain the choice, and a ratchet that bans
    // naming what it rules out just gets worked around.
    const invocations = verify
      .split('\n')
      .filter((l) => l.includes('pnpm exec turbo run typecheck test'));
    expect(invocations).toHaveLength(2);
    const [first, retry] = invocations;
    expect(first).toContain('--continue');
    // `--force` on either would throw away exactly the cached passes that
    // make the retry cheap.
    expect(first).not.toContain('--force');
    expect(retry).not.toContain('--force');
  });

  test('only a second consecutive failure mints verdict=fail', () => {
    const failAt = verify.indexOf('verdict=fail');
    const elifAt = verify.indexOf('elif pnpm exec turbo run typecheck test');
    expect(elifAt).toBeGreaterThan(-1);
    // The install-failure guard mints its own verdict=fail earlier; the one
    // that matters here is the tier verdict, which must sit after the retry.
    expect(verify.lastIndexOf('verdict=fail')).toBeGreaterThan(elifAt);
    expect(failAt).toBeGreaterThan(-1);
  });

  test('an unchanged refusal is paged once, not once per tick', () => {
    // The refused ref stays in the pending pile and re-conflicts on every
    // tick, so a page-per-tick emits the same message every 20 minutes until
    // the cycle consumes it — five identical pages in two hours on 2026-08-05.
    // The gate is the cache lookup; losing it restores the flood silently,
    // because every individual page is still "correct".
    const page = bugLane.slice(
      bugLane.indexOf('- name: Page on a refusal'),
      bugLane.indexOf('- name: Record that this refusal was paged'),
    );
    expect(page).toContain("steps.paged_before.outputs.cache-hit != 'true'");
    expect(bugLane).toContain('actions/cache/save@');
    expect(bugLane).toContain('actions/cache/restore@');
  });

  test('the marker is gated on DELIVERY, not on the page step succeeding', () => {
    // The page step cannot fail: a dead webhook is downgraded to a warning
    // (losing a notification must never fail a release job) and an unset
    // secret returns early, so its conclusion is `success` in both cases while
    // nothing reached anyone. Keying the marker on the step would cache the
    // signature anyway and silence that refusal permanently — strictly worse
    // than the per-tick flood it replaced, which self-healed next tick.
    //
    // Step ORDER is not the property: `Record` sits after `Page` either way,
    // so an ordering assertion stays green while the guarantee is gone.
    // Scoped to the refusal step. Both strings now also appear in the drop
    // step added alongside it, so a whole-file assertion would let either
    // step's copy satisfy the other's test — the sibling-coverage hole that
    // has bitten every ratchet in this block.
    const refusalPage = bugLaneStep('Page on a refusal (armed only)');
    expect(refusalPage).toContain('echo "delivered=${delivered}" >> "$GITHUB_OUTPUT"');
    expect(refusalPage).toContain('delivered=true');
    for (const step of ['Record that this refusal was paged', 'Remember the refusal across ticks']) {
      expect(bugLaneStep(step), `${step} must gate on delivery`).toContain(
        "if: steps.page.outputs.delivered == 'true'",
      );
    }
  });

  test('an unchanged partial drop is paged once, not once per tick', () => {
    // The drop page is a STANDING ANSWER on the same terms as the refusal
    // above: the ref conflicts with the stable on every tick, so without a
    // gate it re-sends an unchanged message every ~20 minutes. Observed
    // 2026-08-21: four identical overnight pages, because the dispatch they
    // accompanied could never land (anchor-drift) and so the candidate set
    // never moved. verdict is `pass` on this path, which is exactly why the
    // refusal's own gate does not cover it.
    expect(bugLaneStep('Notify on a partial drop (armed only)')).toContain(
      "steps.drop_paged_before.outputs.cache-hit != 'true'",
    );
    // Both cache steps, each bounded to itself. A restore key that stops
    // tracking the signature is the per-tick flood this test is named for; if
    // BOTH go constant it is permanent silence for every later drop.
    for (const step of ['Has this drop already been paged?', 'Remember the drop across ticks']) {
      expect(bugLaneStep(step), `${step} must key on the drop signature`).toContain(
        'key: bug-lane-drop-${{ steps.drop.outputs.sig }}',
      );
    }
  });

  test('the drop marker is gated on DELIVERY, not on the notify step succeeding', () => {
    // Same contract as the refusal marker: the notify step cannot fail (an
    // unset secret returns early, a dead webhook downgrades to a warning), so
    // keying the marker on its conclusion would cache the signature even when
    // nothing reached anyone and silence that drop permanently.
    for (const step of ['Record that this drop was paged', 'Remember the drop across ticks']) {
      expect(bugLaneStep(step), `${step} must gate on delivery`).toContain(
        "if: steps.drop_page.outputs.delivered == 'true'",
      );
    }
  });

  test('the drop signature ignores the stable but tracks the dispatched subset', () => {
    // Deliberate asymmetry, inherited from the refusal signature. The
    // operator's move does not change when the stable rolls, and stables roll
    // several times a day — including it would restore most of the flood for a
    // fact already reported. A different surviving subset IS new news, so it
    // stays in.
    const sig = bugLaneStep('Drop signature');
    expect(sig).toContain('"$DROPPED_REFS" "$SURVIVING_REFS"');
    expect(sig).not.toContain('$STABLE');
  });

  test('a suppressed drop still leaves a trace in the run', () => {
    // Same property the refusal path already pins: the suppressing tick has
    // nothing else to show — no page, no marker write, green check — so an
    // operator asking "is that drop still standing?" has only an invisible
    // cache hit to infer it from. The gate is the COMPLEMENT of the notify
    // step's; inverting it makes the note fire alongside the page and never on
    // the tick it exists for.
    const suppress = bugLaneStep('Note a suppressed drop');
    expect(suppress).toContain("if: steps.drop_paged_before.outputs.cache-hit == 'true'");
    expect(suppress).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  test('the drop page states its delivery on every path', () => {
    // The markers key on `delivered`, so the step has to write it whether or
    // not a webhook exists. An early `exit 0` on the no-webhook branch leaves
    // it unset — inert today, since unset and 'false' both fail the gate, but
    // it makes the marker contract depend on a GHA default rather than on a
    // value this step always states.
    const notify = bugLaneStep('Notify on a partial drop (armed only)');
    expect(notify).toContain('echo "delivered=${delivered}" >> "$GITHUB_OUTPUT"');
    expect(notify).not.toContain('exit 0');
  });

  test('a disarmed lane cannot post the drop page', () => {
    // The notify step used to carry `BUG_LANE_ARMED` in its own `if:`. Now that
    // it gates on the signature instead, the armed check survives in exactly
    // ONE place — and it is the only thing keeping a log-only lane from posting
    // to Slack. Losing it there is silent: every other assertion here stays
    // green while a disarmed lane starts paging.
    expect(bugLaneStep('Drop signature')).toContain("env.BUG_LANE_ARMED == 'true'");
  });

  test('the one page it does send says the following silence is deliberate', () => {
    // Paging once and then going quiet is indistinguishable from resolved
    // unless the message says so.
    // Bounded to the Page step: an open-ended slice would also match the
    // phrase in a later step or comment and pass while the message itself
    // had lost it.
    const page = bugLane.slice(
      bugLane.indexOf('- name: Page on a refusal'),
      bugLane.indexOf('- name: Record that this refusal was paged'),
    );
    // The sentence lives in the payload builder the step shells out to, so the
    // contract is "the step composes a body that carries it" rather than "the
    // YAML contains the literal". Assert both halves: the step reaches the
    // builder, and the builder still emits the sentence.
    expect(page).toContain('bug-lane-refusal-payload.mjs');
    expect(
      readFileSync(join(WORKFLOWS, '..', 'scripts', 'bug-lane-refusal-payload.mjs'), 'utf8'),
    ).toContain('Further identical refusals stay silent');
  });

  test('a suppressed refusal still leaves a trace in the run', () => {
    // The suppressing tick is the one with nothing else to show: no page, no
    // marker write, green check. Its condition is the COMPLEMENT of the page
    // step's, which is the regression worth pinning — swapping it to
    // `!= 'true'` makes it fire alongside the page and never on the tick it
    // exists for, and every other test here stays green.
    const suppress = bugLane.slice(
      bugLane.indexOf('- name: Note a suppressed refusal'),
      bugLane.indexOf('- name: Page on a refusal'),
    );
    expect(suppress).toContain("if: steps.paged_before.outputs.cache-hit == 'true'");
    expect(suppress).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  test('the refusal page does not claim a cause it has not established', () => {
    // The prior text asserted "the fix passes on main but not on the stable it
    // would ship against" off a single red run, sending operators hunting for
    // an incompatibility that was really a flake.
    const page = bugLane.slice(bugLane.indexOf('- name: Page on a refusal'));
    expect(page).not.toContain('the fix passes on main but not on the stable');
  });
});

describe('every release-pipeline post prefers the releases webhook', () => {
  const announce = desktopRelease.slice(
    desktopRelease.indexOf('- name: Announce stable release to Slack'),
    desktopRelease.indexOf('- name: Announce stable release to Discord'),
  );

  test('the announcement prefers the releases webhook, falling back to the shared one', () => {
    // A Slack incoming webhook is bound to its channel when it is installed
    // and the payload carries no `channel` field, so this expansion is the
    // ONLY thing deciding which channel the release notes land in.
    expect(announce).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(announce).toContain(
      'WEBHOOK_URL="${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"',
    );
  });

  test('the announcement posts to the resolved URL, never straight to the shared secret', () => {
    // Collapsing this back to "$SLACK_WEBHOOK_URL" is the silent regression:
    // the step still posts and still exits 0, and the notes quietly reappear
    // in the ops channel with nothing failing.
    expect(announce).toContain('--data "$payload" "$WEBHOOK_URL"');
    expect(announce).not.toContain('--data "$payload" "$SLACK_WEBHOOK_URL"');
  });

  test('neither secret set still no-ops rather than posting to an empty URL', () => {
    expect(announce).toContain('if [[ -z "$WEBHOOK_URL" ]]; then');
  });

  test('the blocked-release alarm resolves the same way the announcement does', () => {
    // The alarm is the negative of the announcement — the release that did NOT
    // ship — so it reads as release traffic and belongs with the notes. What
    // must never come back is a bare "$SLACK_WEBHOOK_URL" post: that still
    // exits 0 while the page silently reappears in the product channel.
    const alert = desktopRelease.slice(
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alert).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(alert).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    expect(alert).not.toContain('post "${SLACK_WEBHOOK_URL:-}" Slack');
  });

  // The remaining four moved posts. Ratcheting only the blocked-release alert
  // would leave the stated invariant — no step posts straight at the shared
  // secret — unenforced for most of the steps that moved, and this is the
  // regression class that exits 0 while the page reappears in the product
  // channel, so it is invisible without a test.
  const RESOLVED = 'WEBHOOK_URL="${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"';
  const stepAfter = (source, name, next) =>
    source.slice(
      source.indexOf(`- name: ${name}`),
      next === undefined ? undefined : source.indexOf(`- name: ${next}`),
    );

  for (const { label, step } of [
    {
      label: "the bug lane's refusal page",
      step: () => stepAfter(bugLane, 'Page on a refusal'),
    },
    {
      label: "the bug lane's partial-drop notice",
      step: () => stepAfter(bugLane, 'Notify on a partial drop', 'Page on a refusal'),
    },
    {
      label: 'the fast-tier refusal',
      step: () => stepAfter(selectBeta, 'Record a fast-tier refusal'),
    },
  ]) {
    test(`${label} resolves the releases webhook first`, () => {
      const s = step();
      expect(s).toContain('SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}');
      expect(s).toContain(RESOLVED);
      expect(s).toContain('"$WEBHOOK_URL"');
      // The bare forms this replaced. Either one reaching the curl again puts
      // the page back in the product channel with nothing failing.
      expect(s).not.toContain('--data "$payload" "$SLACK_WEBHOOK_URL"');
      expect(s).not.toContain('if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then');
    });
  }

  test('the aggregate smoke alarm resolves the releases webhook first', () => {
    // This one posts through a `post` helper rather than a bare curl, so it
    // carries the compound expansion at the call site instead of a WEBHOOK_URL
    // assignment.
    const alarm = stepAfter(selectBeta, 'Page the release channel');
    expect(alarm).toContain('SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}');
    expect(alarm).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    expect(alarm).not.toContain('post "${SLACK_WEBHOOK_URL:-}" Slack');
  });
});
