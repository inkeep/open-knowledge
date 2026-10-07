// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell and GitHub expression fixtures must remain literal.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { buildSlackPayload } from './build-smoke-alert-payload.mjs';
import { execFileSync } from './child-tripwire.test-helper.mjs';
import { selectPromotion } from './select-beta-to-promote.mjs';
import { smokePackagedDmg, VERDICT } from './smoke-packaged-dmg.mjs';
import { credentialReasons, holdsCredential } from './workflow-credentials.test-helper.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const desktopRelease = read('desktop-release.yml');
const desktopBuildWinLinux = read('desktop-build-win-linux.yml');
const promoteStable = read('promote-stable.yml');
const releaseYml = read('release.yml');
const bugLane = read('bug-lane.yml');
const bugLaneVerify = read('bug-lane-verify.yml');
const tagCompatiblePnpmSetup =
  'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86';
const desktopReleaseRef = '${{ github.event.client_payload.release_tag || inputs.release_tag }}';
const publishRef = '${{ github.event.client_payload.ref || github.sha }}';

const workflowStep = (source, workflowName, name) => {
  const start = source.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`${workflowName} has no step named ${name}`);
  const rest = source.slice(start);
  const end = rest.indexOf('\n      - name: ');
  return end === -1 ? rest : rest.slice(0, end);
};
const bugLaneVerifyStep = (name) => workflowStep(bugLaneVerify, 'bug-lane-verify.yml', name);
const selectBeta = read('select-beta-to-promote.yml');
const linearRelease = read('linear-release.yml');

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

describe('release jobs install the pnpm version declared by the checked-out tag', () => {
  const taggedJobs = [
    ['desktop-release.yml', desktopRelease, desktopReleaseRef],
    ['release.yml', releaseYml, publishRef],
  ].flatMap(([workflowName, source, expectedRef]) =>
    Object.entries(parse(source).jobs).flatMap(([jobName, job]) => {
      const steps = job.steps ?? [];
      return steps.some(
        (step) => step.uses?.startsWith('actions/checkout@') && step.with?.ref === expectedRef,
      )
        ? [[`${workflowName}#${jobName}`, steps, expectedRef]]
        : [];
    }),
  );

  test('retains the five existing release entry points', () => {
    expect(taggedJobs.map(([label]) => label)).toEqual(
      expect.arrayContaining([
        'desktop-release.yml#prepare',
        'desktop-release.yml#build-macos',
        'desktop-release.yml#build-windows',
        'desktop-release.yml#build-linux',
        'release.yml#build',
      ]),
    );
  });

  test.each(taggedJobs)('%s supports both pnpm 10 and 12 tags', (label, steps, expectedRef) => {
    const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
    const setupNode = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    const pnpmSteps = steps.filter((step) => step.uses?.startsWith('pnpm/'));
    const setup = steps.indexOf(pnpmSteps[0]);

    expect(checkout, `${label} checkout`).toBeGreaterThan(-1);
    expect(steps[checkout].with.ref).toBe(expectedRef);
    expect(setupNode, `${label} Node setup`).toBeGreaterThan(-1);
    expect(pnpmSteps, `${label} pnpm setup`).toHaveLength(1);
    expect(setup).toBeGreaterThan(checkout);
    expect(pnpmSteps[0].uses).toBe(tagCompatiblePnpmSetup);
    expect(pnpmSteps[0].with).toEqual({ cache: false });
  });
});

test('bug-lane-verify installs the pnpm version declared by the stable it verifies', () => {
  const [steps] = Object.values(parse(bugLaneVerify).jobs)
    .map((job) => job.steps ?? [])
    .filter((jobSteps) => jobSteps.some((step) => step.id === 'verify'));
  const stable = steps.findIndex((step) => step.name === 'Check out the stable tag');
  const pnpmSteps = steps.filter((step) => step.uses?.startsWith('pnpm/'));
  const verify = steps.findIndex((step) => step.id === 'verify');

  expect(steps[stable]?.run).toBe('git checkout --detach "$STABLE"');
  expect(pnpmSteps).toHaveLength(1);
  expect(pnpmSteps[0].uses).toBe(tagCompatiblePnpmSetup);
  expect(pnpmSteps[0].with).toBeUndefined();
  expect(steps.indexOf(pnpmSteps[0])).toBeGreaterThan(stable);
  expect(verify).toBeGreaterThan(steps.indexOf(pnpmSteps[0]));
  expect(steps[verify].run).not.toContain('git checkout --detach');
});

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
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('  release-consumers:'));
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
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('  release-consumers:'));
    const conditions = stepLevelIfConditions(shipping);
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
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const desktopRequire = createRequire(join(repoRoot, 'packages/desktop/package.json'));
    const ebMain = desktopRequire.resolve('electron-builder');
    const ablRequire = createRequire(ebMain);
    const ablMain = ablRequire.resolve('app-builder-lib');
    const scheme = JSON.parse(readFileSync(join(dirname(ablMain), '..', 'scheme.json'), 'utf8'));
    const required = scheme.definitions.WindowsAzureSigningConfiguration.required;
    expect(required.length).toBeGreaterThanOrEqual(3);

    for (const workflow of [desktopRelease, desktopBuildWinLinux]) {
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

describe('the optional Windows signing lane proves what it reports', () => {
  test('signing_ran is authored only after Authenticode attestation succeeds', () => {
    const attestation = desktopBuildWinLinux.indexOf('id: attest-windows-signing');
    expect(attestation).toBeGreaterThan(0);
    expect(desktopBuildWinLinux.slice(0, attestation)).not.toContain('signing_ran=true');
    expect(desktopBuildWinLinux.slice(attestation)).toContain(
      "Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value 'signing_ran=true'",
    );
    expect(desktopBuildWinLinux).toContain('steps.attest-windows-signing.outputs.signing_ran');
  });

  test('attests and package-checks both Windows outer architectures', () => {
    for (const dir of ['dist-desktop/win-unpacked', 'dist-desktop/win-arm64-unpacked']) {
      expect(desktopBuildWinLinux).toContain(`Path = '${dir}'`);
      expect(desktopBuildWinLinux).toContain(`OK_WIN_PACKAGE_DIR: ${dir}`);
    }
  });
});

describe('the publishing Windows lane attests its signed native payload', () => {
  const GATE_CONDITION = "success() && steps.winterm.outputs.ships == 'true'";

  test('checks both outer architectures before staging release assets', () => {
    const detect = desktopRelease.indexOf(
      '- name: Detect whether this ref packages the Windows terminal',
    );
    const attest = desktopRelease.indexOf('- name: Attest signed Windows packages', detect);
    const conpty = desktopRelease.indexOf(
      '- name: Attest preserved Microsoft signatures on the packaged ConPTY pairs',
      attest,
    );
    const asar = desktopRelease.indexOf(
      '- name: Assert the packaged asar carries its dependencies',
      attest,
    );
    const upload = desktopRelease.indexOf(
      '- name: Upload Windows release assets for the fan-in publisher',
      attest,
    );

    expect(detect).toBeGreaterThan(0);
    expect(detect).toBeLessThan(attest);
    expect(attest).toBeLessThan(conpty);
    expect(conpty).toBeLessThan(asar);
    expect(asar).toBeLessThan(upload);
    const attestationSteps = desktopRelease.slice(attest, asar);
    expect(attestationSteps).toContain('Get-AuthenticodeSignature');
    expect(attestationSteps).toContain("-notmatch 'Microsoft'");
    expect(attestationSteps.match(/OK_WIN_PACKAGE_REQUIRED: "1"/gu) ?? []).toHaveLength(2);
    expect(attestationSteps).not.toContain('continue-on-error:');
    const conditions = stepLevelIfConditions(attestationSteps);
    expect(conditions).toHaveLength(3);
    for (const condition of conditions) {
      expect(condition).toBe(GATE_CONDITION);
    }
    for (const dir of ['dist-desktop/win-unpacked', 'dist-desktop/win-arm64-unpacked']) {
      expect(attestationSteps).toContain(`Path = '${dir}'`);
      expect(attestationSteps).toContain(`OK_WIN_PACKAGE_DIR: ${dir}`);
    }
  });

  test('the tree gate probes the pre-terminal exclusion and fails closed', () => {
    const detectStep = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Detect whether this ref packages the Windows terminal',
    );
    expect(detectStep).toContain('packages/desktop/electron-builder.yml');
    expect(detectStep).toContain('grep -qF -- \'- "!**/node_modules/node-pty/**"\'');
    expect(detectStep.indexOf('ships=false')).toBeGreaterThan(-1);
    expect(detectStep.indexOf('ships=false')).toBeLessThan(detectStep.indexOf('ships=true'));
    const appAttestation = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Attest signed Windows packages',
    );
    expect(stepLevelIfConditions(appAttestation)).toHaveLength(0);
  });

  test('keeps the shared signature-preservation core in both Windows lanes', () => {
    const releaseAppStep = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Attest signed Windows packages',
    );
    expect(releaseAppStep).toContain('$signature = Get-AuthenticodeSignature $appExecutable');

    const conptyTokens = [
      '$signature = Get-AuthenticodeSignature $path',
      "-notmatch 'Microsoft'",
      "foreach ($name in @('conpty.dll', 'OpenConsole.exe'))",
      'node-pty[\\\\/]prebuilds[\\\\/]win32-(x64|arm64)[\\\\/]conpty$',
    ];
    const releaseConptyStep = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Attest preserved Microsoft signatures on the packaged ConPTY pairs',
    );
    for (const token of conptyTokens) {
      expect(releaseConptyStep).toContain(token);
    }

    const qaAttestationStep = workflowStep(
      desktopBuildWinLinux,
      'desktop-build-win-linux.yml',
      'Attest signed Windows packages and preserved Microsoft signatures',
    );
    for (const token of [
      '$signature = Get-AuthenticodeSignature $appExecutable',
      ...conptyTokens,
    ]) {
      expect(qaAttestationStep).toContain(token);
    }
  });
});

describe('the fan-in publication DAG gates every platform', () => {
  test.each([0, 1])(
    'dispatch failure pages independently of publication (webhook exit %s)',
    (status) => {
      const job = parse(desktopRelease).jobs['release-consumers'];
      const alert = job.steps.find((step) => step.name === 'Alert on failed publication dispatch');
      expect(alert.if).toBe('failure() || cancelled()');
      const dir = mkdtempSync(join(tmpdir(), 'ok-dispatch-alert-'));
      try {
        const capture = join(dir, 'post');
        const output = execFileSync(
          'bash',
          ['-c', `curl() { printf '%s\\n' "$*" >> "$CAPTURE"; return ${status}; }\n${alert.run}`],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              RELEASE_TAG: 'v0.78.0-beta.6',
              GITHUB_SERVER_URL: 'https://github.com',
              GITHUB_REPOSITORY: 'inkeep/open-knowledge',
              GITHUB_RUN_ID: '123',
              GITHUB_STEP_SUMMARY: join(dir, 'summary'),
              SLACK_RELEASES_WEBHOOK_URL: 'https://example.test/slack',
              CAPTURE: capture,
            },
          },
        );
        expect(readFileSync(capture, 'utf8')).toContain(
          'Release v0.78.0-beta.6 is published, but its notification dispatch failed',
        );
        expect(readFileSync(capture, 'utf8')).toContain('desktop-release-published');
        expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain(
          'do not rebuild or republish installers',
        );
        expect(output.includes('could not be delivered')).toBe(status !== 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('consumers run only after the draft flip and cannot gate installer publication', () => {
    const { jobs } = parse(desktopRelease);
    expect(jobs['release-consumers'].needs).toBe('finalize');
    expect(jobs['release-consumers'].if).toBe(
      "${{ !cancelled() && needs.finalize.outputs.published == 'true' }}",
    );
    expect(jobs.finalize.outputs.published).toBe('${{ steps.publish.outputs.published }}');
    const publish = jobs.finalize.steps.find((step) => step.id === 'publish');
    expect(publish.run.indexOf('echo "published=true"')).toBeGreaterThan(
      publish.run.lastIndexOf('gh release edit'),
    );
    expect(jobs['release-consumers'].steps[0].run).toContain('desktop-release-published');
    for (const job of [
      'prepare',
      'build-macos',
      'build-windows',
      'build-linux',
      'publish-assets',
      'finalize',
    ]) {
      expect(JSON.stringify(jobs[job].needs ?? [])).not.toContain('release-consumers');
    }
    for (const consumer of ['write-back.yml', 'linear-release.yml']) {
      expect(parse(read(consumer)).on.repository_dispatch.types).toEqual([
        'desktop-release-published',
      ]);
    }
  });

  test('source builds use the immutable release tag while recovery tooling uses the workflow revision', () => {
    const { jobs } = parse(desktopRelease);
    for (const job of ['prepare', 'build-macos', 'build-windows', 'build-linux']) {
      const checkout = jobs[job].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout.with.ref).toBe(
        '${{ github.event.client_payload.release_tag || inputs.release_tag }}',
      );
    }
    const upgrade = jobs['build-macos'].steps.find(
      (step) => step.name === 'Verify a historical app can update in place',
    );
    expect(upgrade.run).toContain(
      'git restore --source "$WORKFLOW_SHA" --worktree .github/scripts/smoke-historical-upgrade.mjs .github/scripts/dmg-mount.mjs',
    );
    expect(upgrade.env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}');
  });

  test('publish-assets waits on all four build jobs', () => {
    expect(desktopRelease).toContain('needs: [prepare, build-macos, build-windows, build-linux]');
  });

  test('finalize waits on publish-assets (and the smoke via build-macos)', () => {
    expect(desktopRelease).toContain('needs: [prepare, build-macos, publish-assets]');
  });

  test('no variant builder invocation publishes; only the fan-in touches the Release', () => {
    expect(desktopRelease).not.toContain('--publish always');
    const invocations = [
      ...desktopRelease.matchAll(/pnpm exec node "\$DESKTOP_PACKAGER" --(?:mac|win|linux)/g),
    ];
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
    expect(pa).toContain('!cancelled()');
    const fin = desktopRelease.slice(
      desktopRelease.indexOf('\n  finalize:'),
      desktopRelease.indexOf('\n  alert:'),
    );
    expect(fin).toContain('!cancelled()');
    expect(fin).toContain("needs.publish-assets.result == 'success'");
    expect(fin).toContain("needs.build-macos.result == 'success'");
    expect(desktopRelease).toMatch(
      /::error::DESKTOP_RELEASE_REQUIRED_PLATFORMS must include 'mac'[^"]*"\s*\n\s*exit 1/,
    );
  });

  test('the alert pages on a blocked RELEASE, not on any failed job', () => {
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
    publishedAt: '2026-07-28T11:00:00Z',
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
    const fake = join(scratch, 'NotReallyOpenKnowledge.dmg');
    writeFileSync(fake, 'this is not a disk image\n');

    const result = await smokePackagedDmg(fake, {
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
    const step = smokeStep();
    expect(step).toContain('git fetch --depth=1 origin "$GITHUB_SHA"');
    expect(step).toContain('git checkout "$GITHUB_SHA" --');
    expect(step).toContain('.github/scripts/dmg-mount.mjs');
  });

  test('the overlay cannot newly gate a ref that predates the harness', () => {
    const step = smokeStep();
    expect(step.indexOf('ref predates the harness')).toBeLessThan(
      step.indexOf('git checkout "$GITHUB_SHA" --'),
    );
  });

  test('the overlay degrades to the tag copy instead of blocking the release', () => {
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
    expect(scoped('- name: Smoke the packaged DMG (FR5b)')).toContain(
      "if: steps.channel.outputs.channel == 'latest'",
    );
  });

  test('the alert is stable-only too, so a beta hiccup does not page', () => {
    expect(scoped('- name: Alert on a blocked release (FR5c)')).toContain(
      "if: needs.prepare.outputs.channel == 'latest'",
    );
  });

  test('the beta path keeps its existing stuck-draft warning', () => {
    const warn = scoped('- name: Warn on stuck draft');
    expect(warn).toContain('RECOVERY="gh release edit');
    expect(warn).not.toContain("if: needs.prepare.outputs.channel == 'latest'");
  });
});

describe('the bug lane hands off instead of verifying in the evaluator', () => {
  test('the evaluator dispatches the verify workflow rather than running it', () => {
    expect(bugLane).toContain('gh workflow run bug-lane-verify.yml');
    expect(bugLane).not.toContain('- name: Verify the synthetic tree');
    expect(bugLane).not.toContain('git cherry-pick');
    expect(bugLane).not.toContain('turbo run typecheck test');
  });

  test('the evaluator will not queue a second verify behind a running one', () => {
    const inflight = bugLane.slice(
      bugLane.indexOf('- name: Skip while a release'),
      bugLane.indexOf('- name: Hand the batch to the verify workflow'),
    );
    expect(inflight.length).toBeGreaterThan(0);
    expect(inflight).toMatch(/for wf in [^\n]*bug-lane-verify\.yml/);
  });

  test('the verify half queues rather than cancelling a run mid-pick', () => {
    const concurrency = bugLaneVerify.slice(
      bugLaneVerify.indexOf('concurrency:'),
      bugLaneVerify.indexOf('env:'),
    );
    expect(concurrency).toContain('cancel-in-progress: false');
  });

  test('the verify half runs only on dispatch, so it cannot colour a commit', () => {
    const triggers = bugLaneVerify.slice(
      bugLaneVerify.indexOf('\non:'),
      bugLaneVerify.indexOf('\npermissions:'),
    );
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toContain('schedule:');
    expect(triggers).not.toMatch(/^\s*push:/m);
  });

  test('the arming switch moved with the steps that read it', () => {
    expect(bugLaneVerify).toContain('BUG_LANE_ARMED: "true"');
    expect(bugLane).not.toContain('BUG_LANE_ARMED:');
  });
});

describe('the failing-test names reach the refusal page', () => {
  test('the verify step publishes them as an output', () => {
    const verify = bugLaneVerifyStep('Verify the synthetic tree (cherry-pick + fast test tiers)');
    expect(verify).toContain('failures<<FAILURES_EOF');
    expect(verify).toContain('printf \'%s\\n\' "$FAILURES_JSON"');
  });

  test('the paging step reads that output and hands it to the payload builder', () => {
    const page = bugLaneVerifyStep('Page on a refusal (armed only)');
    expect(page).toContain('FAILURES: ${{ steps.verify.outputs.failures }}');
    expect(page).toContain('FAILURES_JSON="${FAILURES:-}"');
    expect(page).toContain('--argjson failures "$FAILURES_JSON"');
  });
});

describe('the bug lane verifies the synthetic tree at the same bar as main', () => {
  const verify = bugLaneVerify.slice(
    bugLaneVerify.indexOf('- name: Verify the synthetic tree'),
    bugLaneVerify.indexOf('- name: Dispatch the point release'),
  );

  test('a red tier gets one retry before the tick is refused', () => {
    const runs = [...verify.matchAll(/turbo run typecheck test/g)];
    expect(runs.length, 'verify must invoke the tiers twice: once, then one flake retry').toBe(2);
    expect(verify).toContain('case "$FIRST_STATUS" in');
    const ordinaryArm = verify.indexOf('*)', verify.indexOf('case "$FIRST_STATUS" in'));
    expect(ordinaryArm, 'the ordinary-failure arm must exist').toBeGreaterThan(-1);
    expect(verify.indexOf('| tee "$RETRY_LOG"')).toBeGreaterThan(ordinaryArm);
  });

  test('the first attempt runs to completion so the retry stays incremental', () => {
    const invocations = verify
      .split('\n')
      .filter((l) => l.includes('pnpm exec turbo run typecheck test'));
    expect(invocations).toHaveLength(2);
    const [first, retry] = invocations;
    expect(first).toContain('--continue');
    expect(first).not.toContain('--force');
    expect(retry).not.toContain('--force');
  });

  test('both attempts run every package, so a filter cannot drop server#test or the uncached tier from the verified tree', () => {
    const commands = verify
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((l) => l.includes('pnpm exec turbo run typecheck test'));
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(command).not.toMatch(/\s(--filter|-F)[\s=]/);
  });

  test('only a second consecutive failure mints a refusing verdict', () => {
    const installGuardAt = verify.indexOf('verdict=fail');
    const retryAt = verify.indexOf('| tee "$RETRY_LOG"');
    expect(retryAt).toBeGreaterThan(-1);
    expect(installGuardAt).toBeGreaterThan(-1);
    expect(installGuardAt).toBeLessThan(retryAt);
    expect(verify.indexOf('verdict=${TIER_VERDICT}')).toBeGreaterThan(retryAt);
  });

  test('each tier attempt runs under its own budget, and a blown one still pages', () => {
    const wrappers = [...verify.matchAll(/timeout --foreground --kill-after=\d+s/g)];
    expect(wrappers.length, 'both attempts must carry their own budget').toBe(2);

    const gateAt = verify.indexOf(
      '"${TIER_VERDICT:-fail}" == "could-not-verify" ]]; then\n              echo',
    );
    expect(gateAt, 'the warning must branch on the computed budget flag').toBeGreaterThan(-1);
    const couldNotVerifyAt = verify.indexOf('COULD NOT VERIFY', gateAt);
    const notFlakeAt = verify.indexOf('not flake-class', gateAt);
    expect(couldNotVerifyAt).toBeGreaterThan(gateAt);
    expect(notFlakeAt).toBeGreaterThan(couldNotVerifyAt);

    const caseAt = verify.indexOf('case "$FIRST_STATUS" in');
    expect(caseAt).toBeGreaterThan(-1);
    const blowArm = verify.indexOf('124|137)', caseAt);
    const ordinaryRetryArm = verify.indexOf('*)', caseAt);
    expect(blowArm, 'the budget arm must sit inside the FIRST_STATUS case').toBeGreaterThan(caseAt);
    expect(blowArm, 'the budget arm must precede the retry arm').toBeLessThan(ordinaryRetryArm);
  });

  test('a tick that mints no verdict still refuses out loud', () => {
    const guard = bugLaneVerify.indexOf("steps.verify.outputs.verdict == ''");
    expect(guard, 'a no-verdict tick must still page').toBeGreaterThan(-1);
    const always = bugLaneVerify.lastIndexOf('always()', guard);
    expect(always, 'the guard is useless without always()').toBeGreaterThan(-1);
    expect(guard - always).toBeLessThan(40);
    const emits = bugLaneVerify.indexOf('::warning::', guard);
    expect(emits, 'the guarded step must emit something').toBeGreaterThan(guard);
    expect(bugLaneVerify.slice(guard, emits + 200)).toContain('COULD NOT VERIFY');
  });

  test('a budget blow and a real refusal do not share a page signature', () => {
    const sigFrom = bugLaneVerify.indexOf('- name: Refusal signature');
    const sigTo = bugLaneVerify.indexOf('- name: Has this refusal already been paged?');
    expect(sigFrom).toBeGreaterThan(-1);
    expect(sigTo).toBeGreaterThan(sigFrom);
    const sig = bugLaneVerify.slice(sigFrom, sigTo);
    expect(sig).toContain('VERDICT: ${{ steps.verify.outputs.verdict }}');
    expect(sig).toContain('bug-lane-refusal-key.mjs');
    expect(verify).toContain('TIER_VERDICT=could-not-verify');
    expect(bugLaneVerify).not.toContain('budget_blown');
  });

  test('an unchanged refusal is paged once, not once per tick', () => {
    const page = bugLaneVerify.slice(
      bugLaneVerify.indexOf('- name: Page on a refusal'),
      bugLaneVerify.indexOf('- name: Record that this refusal was paged'),
    );
    expect(page).toContain("steps.paged_before.outputs.cache-hit != 'true'");
    expect(bugLaneVerify).toContain('actions/cache/save@');
    expect(bugLaneVerify).toContain('actions/cache/restore@');
  });

  test('a missing grouping helper still emits a usable batch-based paging key', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ok-refusal-key-'));
    try {
      const output = join(scratch, 'output');
      const script = bugLaneVerifyStep('Refusal signature')
        .split('run: |')[1]
        .split('\n')
        .map((line) => line.replace(/^ {10}/, ''))
        .join('\n');
      const stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RUNNER_TEMP: scratch,
          GITHUB_OUTPUT: output,
          GITHUB_SHA: '0000000000000000000000000000000000000000',
          VERDICT: 'fail',
          FIX_REFS: 'a,b',
          SURVIVING_REFS: 'a',
        },
      });
      const expected = createHash('sha256').update('fail|a,b|a').digest('hex').slice(0, 32);
      expect(stdout).toContain('retaining batch-based paging');
      expect(readFileSync(output, 'utf8')).toContain(`sig=${expected}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('the marker is gated on DELIVERY, not on the page step succeeding', () => {
    const refusalPage = bugLaneVerifyStep('Page on a refusal (armed only)');
    expect(refusalPage).toContain('echo "delivered=${delivered}" >> "$GITHUB_OUTPUT"');
    expect(refusalPage).toContain('delivered=true');
    for (const step of [
      'Record that this refusal was paged',
      'Remember the refusal across ticks',
    ]) {
      expect(bugLaneVerifyStep(step), `${step} must gate on delivery`).toContain(
        "if: steps.page.outputs.delivered == 'true'",
      );
    }
  });

  test('an unchanged partial drop is paged once, not once per tick', () => {
    expect(bugLaneVerifyStep('Notify on a partial drop (armed only)')).toContain(
      "steps.drop_paged_before.outputs.cache-hit != 'true'",
    );
    for (const step of ['Has this drop already been paged?', 'Remember the drop across ticks']) {
      expect(bugLaneVerifyStep(step), `${step} must key on the drop signature`).toContain(
        'key: bug-lane-drop-${{ steps.drop.outputs.sig }}',
      );
    }
  });

  test('the drop marker is gated on DELIVERY, not on the notify step succeeding', () => {
    for (const step of ['Record that this drop was paged', 'Remember the drop across ticks']) {
      expect(bugLaneVerifyStep(step), `${step} must gate on delivery`).toContain(
        "if: steps.drop_page.outputs.delivered == 'true'",
      );
    }
  });

  test('the drop signature ignores the stable but tracks the dispatched subset', () => {
    const sig = bugLaneVerifyStep('Drop signature');
    expect(sig).toContain('"$DROPPED_REFS" "$SURVIVING_REFS"');
    expect(sig).not.toContain('$STABLE');
  });

  test('a suppressed drop still leaves a trace in the run', () => {
    const suppress = bugLaneVerifyStep('Note a suppressed drop');
    expect(suppress).toContain("if: steps.drop_paged_before.outputs.cache-hit == 'true'");
    expect(suppress).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  test('the drop page states its delivery on every path', () => {
    const notify = bugLaneVerifyStep('Notify on a partial drop (armed only)');
    expect(notify).toContain('echo "delivered=${delivered}" >> "$GITHUB_OUTPUT"');
    expect(notify).not.toContain('exit 0');
  });

  test('a disarmed lane cannot post the drop page', () => {
    expect(bugLaneVerifyStep('Drop signature')).toContain("env.BUG_LANE_ARMED == 'true'");
  });

  test('the one page it does send is built by the refusal payload module', () => {
    const page = bugLaneVerify.slice(
      bugLaneVerify.indexOf('- name: Page on a refusal'),
      bugLaneVerify.indexOf('- name: Record that this refusal was paged'),
    );
    expect(page).toContain('bug-lane-refusal-payload.mjs');
  });

  test('a suppressed refusal still leaves a trace in the run', () => {
    const suppress = bugLaneVerify.slice(
      bugLaneVerify.indexOf('- name: Note a suppressed refusal'),
      bugLaneVerify.indexOf('- name: Page on a refusal'),
    );
    expect(suppress).toContain("if: steps.paged_before.outputs.cache-hit == 'true'");
    expect(suppress).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  test('the refusal page does not claim a cause it has not established', () => {
    const page = bugLaneVerifyStep('Page on a refusal (armed only)');
    expect(page).not.toContain('the fix passes on main but not on the stable');
  });
});

describe('every release-pipeline post prefers the releases webhook', () => {
  const announce = desktopRelease.slice(
    desktopRelease.indexOf('- name: Announce stable release to Slack'),
    desktopRelease.indexOf('- name: Announce stable release to Discord'),
  );

  test('the announcement prefers the releases webhook, falling back to the shared one', () => {
    expect(announce).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(announce).toContain(
      'WEBHOOK_URL="${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"',
    );
  });

  test('the announcement posts to the resolved URL, never straight to the shared secret', () => {
    expect(announce).toContain('--data "$payload" "$WEBHOOK_URL"');
    expect(announce).not.toContain('--data "$payload" "$SLACK_WEBHOOK_URL"');
  });

  test('neither secret set still no-ops rather than posting to an empty URL', () => {
    expect(announce).toContain('if [[ -z "$WEBHOOK_URL" ]]; then');
  });

  test('the blocked-release alarm resolves the same way the announcement does', () => {
    const alert = desktopRelease.slice(
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alert).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(alert).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    expect(alert).not.toContain('post "${SLACK_WEBHOOK_URL:-}" Slack');
  });

  const RESOLVED = 'WEBHOOK_URL="${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"';
  const stepAfter = (source, name, next) => {
    const start = source.indexOf(`- name: ${name}`);
    if (start === -1) throw new Error(`no step named ${name}`);
    return source.slice(start, next === undefined ? undefined : source.indexOf(`- name: ${next}`));
  };

  for (const { label, step } of [
    {
      label: "the bug lane's refusal page",
      step: () => stepAfter(bugLaneVerify, 'Page on a refusal'),
    },
    {
      label: "the bug lane's partial-drop notice",
      step: () => stepAfter(bugLaneVerify, 'Notify on a partial drop', 'Page on a refusal'),
    },
    {
      label: "the Linear stamp's failure page",
      step: () => stepAfter(linearRelease, 'Alert on failed stamping'),
    },
  ]) {
    test(`${label} resolves the releases webhook first`, () => {
      const s = step();
      expect(s).toContain('SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}');
      expect(s).toContain(RESOLVED);
      expect(s).toMatch(/--data "\$payload"[\s\\]*"\$WEBHOOK_URL"/);
      expect(s).not.toMatch(/--data "\$payload"[\s\\]*"\$SLACK_WEBHOOK_URL"/);
      expect(s).not.toContain('if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then');
    });
  }

  test('the aggregate smoke alarm resolves the releases webhook first', async () => {
    const alarm = stepAfter(selectBeta, 'Page the release channel');
    expect(alarm).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(alarm).toContain('node .github/scripts/release-alert-state.mjs');
    const { execFile } = await import('node:child_process');
    const { createServer } = await import('node:http');
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      request.resume();
      response.end('ok');
    });
    const dir = mkdtempSync(join(tmpdir(), 'ok-webhook-precedence-'));
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      let index = 0;
      const state = (value) => (value === undefined ? 'unset' : value ? 'set' : 'empty');
      for (const releases of [undefined, '', `${origin}/releases`]) {
        for (const fallback of [undefined, '', `${origin}/fallback`]) {
          requests.length = 0;
          const label = `releases webhook ${state(releases)}, fallback webhook ${state(fallback)}`;
          const statePath = join(dir, `state-${index++}.json`);
          const env = {
            ...process.env,
            ALERT_STATE_PATH: statePath,
            ALERT_INCIDENT: 'smoke-failure',
            ALERT_TEXT: 'webhook precedence test',
          };
          delete env.SLACK_RELEASES_WEBHOOK_URL;
          delete env.SLACK_WEBHOOK_URL;
          delete env.GITHUB_OUTPUT;
          delete env.NODE_OPTIONS;
          if (releases !== undefined) env.SLACK_RELEASES_WEBHOOK_URL = releases;
          if (fallback !== undefined) env.SLACK_WEBHOOK_URL = fallback;
          const result = await new Promise((resolve) => {
            execFile(
              process.execPath,
              [join(WORKFLOWS, '..', 'scripts', 'release-alert-state.mjs')],
              { env, timeout: 5_000 },
              (error, _stdout, stderr) => resolve({ error, stderr }),
            );
          });
          const target = releases ? '/releases' : fallback ? '/fallback' : undefined;
          const ended = result.error?.signal ?? `exit code ${result.error ? result.error.code : 0}`;
          const outcome = `${label}, reporter ended with ${ended}: ${result.stderr}`;
          expect(requests, outcome).toEqual(target ? [target] : []);
          expect(result.error ? result.error.code : 0, outcome).toBe(target ? 0 : 1);
          expect(existsSync(statePath), outcome).toBe(Boolean(target));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  test('fast-tier attempts have one incident reporter and save only successful acknowledgements', () => {
    const { jobs } = parse(selectBeta);
    const attemptJobs = ['smoke-fast-tier-candidate', 'dispatch-fast-tier-candidate'];
    const reports = attemptJobs.flatMap((id) =>
      jobs[id].steps.filter((step) => /\bfailure\(\)/.test(step.if ?? '')).map((step) => `${id}: ${step.name}`),
    );
    expect(reports).toEqual([
      'smoke-fast-tier-candidate: Record a fast-tier refusal',
      'dispatch-fast-tier-candidate: Report a failed fast-tier dispatch',
    ]);
    for (const id of attemptJobs) {
      for (const step of jobs[id].steps) {
        const text = JSON.stringify(step);
        expect(text, `${id}: ${step.name}`).not.toContain('curl');
        expect(text, `${id}: ${step.name}`).not.toMatch(/SLACK_\w*WEBHOOK_URL/);
      }
    }
    for (const id of ['read-smoke-incident', 'page-smoke-incident']) {
      expect(jobs[id].if, id).toBe("needs.aggregate-smoke-alarm.outputs.observed == 'true'");
    }
    expect(stepAfter(selectBeta, 'Remember the smoke incident acknowledgement')).toContain(
      "if: steps.page.outcome == 'success' && steps.page.outputs.notified == 'true'",
    );
  });

  test('a failed fast-tier dispatch reports that the smoke passed and nothing was dispatched', () => {
    const [report] = parse(selectBeta).jobs['dispatch-fast-tier-candidate'].steps.filter(
      (step) => step.name === 'Report a failed fast-tier dispatch',
    );
    expect(report.if).toBe('failure()');
    expect(report.run).toMatch(/smoke passed for \$\{CANDIDATE\}, but the dispatch failed, so promote-stable was not dispatched/);
    expect(report.run).toMatch(/smoke passed for \$\{CANDIDATE\}, but the dispatch failed and promote-stable was not dispatched/);
    expect(report.run).not.toMatch(/refused|verdict=/);
  });

  test('a beta whose DMG failed the smoke is remembered by tag and not re-smoked on later ticks', () => {
    const { jobs } = parse(selectBeta);
    const step = (job, name) => {
      const found = jobs[job].steps.find((s) => s.name === name);
      if (!found)
        throw new Error(`select-beta-to-promote.yml job ${job} has no step named ${name}`);
      return found;
    };
    expect(jobs.evaluate['runs-on']).toBe('ubuntu-latest');
    expect(jobs.evaluate.outputs.fast_tier_candidate).toBe(
      '${{ steps.nominate.outputs.fast_tier_candidate }}',
    );
    const lookup = step('evaluate', 'Look up an earlier smoke failure for the fast-tier candidate');
    expect(lookup.id).toBe('prior-failure');
    expect(lookup.if).toContain("github.event_name != 'workflow_dispatch'");
    expect(lookup.with).toEqual({
      path: 'fast-tier-smoke-failed',
      key: 'fast-tier-smoke-failed-v1-${{ steps.select.outputs.fast_tier_candidate }}',
      'lookup-only': true,
    });
    expect(
      step('evaluate', 'Skip the fast-tier candidate whose DMG already failed the smoke').if,
    ).toBe("steps.prior-failure.outputs.cache-hit == 'true'");

    const nominate = step('evaluate', 'Nominate the fast-tier candidate for smoking');
    expect(nominate.env.ALREADY_FAILED).toBe('${{ steps.prior-failure.outputs.cache-hit }}');
    const nominated = (candidate, alreadyFailed) => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-nominate-'));
      try {
        const out = join(dir, 'out');
        writeFileSync(out, '');
        execFileSync('bash', ['-c', nominate.run], {
          env: {
            ...process.env,
            CANDIDATE: candidate,
            ALREADY_FAILED: alreadyFailed,
            GITHUB_OUTPUT: out,
          },
        });
        return readFileSync(out, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(nominated('v1.2.3-beta.0', '')).toBe('fast_tier_candidate=v1.2.3-beta.0\n');
    expect(nominated('v1.2.3-beta.0', 'false')).toBe('fast_tier_candidate=v1.2.3-beta.0\n');
    expect(nominated('v1.2.3-beta.0', 'true')).toBe('fast_tier_candidate=\n');
    expect(nominated('', '')).toBe('fast_tier_candidate=\n');

    expect(jobs['smoke-fast-tier-candidate'].outputs.verdict).toBe(
      '${{ steps.smoke.outputs.verdict }}',
    );
    const remember = jobs['remember-smoke-failure'];
    expect(remember['runs-on']).toBe('ubuntu-latest');
    expect(remember.needs).toEqual(['evaluate', 'smoke-fast-tier-candidate']);
    expect(remember.if).toBe(
      "always() && needs.smoke-fast-tier-candidate.outputs.verdict == 'fail'",
    );
    expect(step('remember-smoke-failure', 'Save the failure marker').with).toEqual({
      path: 'fast-tier-smoke-failed',
      key: 'fast-tier-smoke-failed-v1-${{ needs.evaluate.outputs.fast_tier_candidate }}',
    });
  });

  test('bug verification provisions the native runtime before testing the stable tree', () => {
    const setup = bugLaneVerify.indexOf('- name: Setup uv for ACP package acquisition tests');
    expect(setup).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(bugLaneVerify.indexOf('- name: Verify the synthetic tree'));
    expect(bugLaneVerifyStep('Verify ACP package acquisition prerequisites')).toContain(
      'uvx --version',
    );
  });
});

const macPackagingJobs = [
  {
    label: 'desktop-release.yml#build-macos',
    steps: parse(desktopRelease).jobs['build-macos'].steps,
    bundle: 'Build desktop main/preload/renderer',
    packager: 'Build + sign + notarize DMG/ZIP',
  },
  {
    label: 'desktop-build.yml#build-macos-dmg',
    steps: parse(read('desktop-build.yml')).jobs['build-macos-dmg'].steps,
    bundle: 'Build electron-vite bundles',
    packager: 'Package DMG (${{ steps.signmode.outputs.mode }})',
  },
];
const macStepIndex = (job, name) => {
  const at = job.steps.findIndex((step) => step.name === name);
  if (at === -1) throw new Error(`${job.label} has no step named ${name}`);
  return at;
};
const macStepsBeforeSigning = (job) => [
  'Force-install darwin keyring prebuilds for universal merge',
  'Stage @parcel/watcher for the bundled CLI',
  job.bundle,
  'Validate variant provisioning profile',
];

describe('macOS signing stays on the workflow-staged keychain', () => {
  const desktopBuild = read('desktop-build.yml');
  const PREPARE = 'Prepare signing keychain (CSC_KEYCHAIN)';
  const EXPORT = 'echo "CSC_KEYCHAIN=$KEYCHAIN_PATH" >> "$GITHUB_ENV"';
  const runBody = (step) => {
    const start = step.indexOf('run: |');
    const end = step.indexOf(EXPORT);
    if (start === -1 || end === -1) throw new Error('staging step lost its run body or export');
    return step.slice(start, end + EXPORT.length);
  };
  const releasePrepare = workflowStep(desktopRelease, 'desktop-release.yml', PREPARE);
  const buildPrepare = workflowStep(desktopBuild, 'desktop-build.yml', PREPARE);
  const releasePackager = workflowStep(
    desktopRelease,
    'desktop-release.yml',
    'Build + sign + notarize DMG/ZIP',
  );
  const buildPackager = workflowStep(
    desktopBuild,
    'desktop-build.yml',
    'Package DMG (${{ steps.signmode.outputs.mode }})',
  );

  test('the twin staging steps carry the same run body', () => {
    expect(runBody(releasePrepare)).toEqual(runBody(buildPrepare));
  });

  test('the staging step authenticates the partition list with the keychain password', () => {
    for (const step of [releasePrepare, buildPrepare]) {
      const partitionCall = runBody(step)
        .replace(/\\\n\s+/g, ' ')
        .split('\n')
        .find((line) => line.includes('set-key-partition-list'));
      expect(partitionCall).toBeDefined();
      expect(partitionCall).toContain('-k "$KEYCHAIN_PASSWORD"');
      expect(partitionCall).not.toContain('CSC_KEY_PASSWORD');
      expect(step).toContain(EXPORT);
    }
  });

  test('the staging step runs after the unsigned build steps, just before the packager, in both workflows', () => {
    for (const job of macPackagingJobs) {
      const prepare = macStepIndex(job, PREPARE);
      for (const name of macStepsBeforeSigning(job)) {
        expect(prepare, `${job.label}: ${PREPARE} must follow ${name}`).toBeGreaterThan(
          macStepIndex(job, name),
        );
      }
      expect(
        job.steps.slice(prepare + 1, macStepIndex(job, job.packager)).map((step) => step.name),
        `${job.label}: only the key materialization may sit between ${PREPARE} and the packager`,
      ).toEqual(['Materialize App Store Connect API key']);
    }
  });

  test('neither packager step receives CSC_LINK or CSC_KEY_PASSWORD', () => {
    for (const step of [releasePackager, buildPackager]) {
      expect(step).not.toMatch(/^\s+CSC_LINK:/m);
      expect(step).not.toMatch(/^\s+CSC_KEY_PASSWORD:/m);
    }
  });

  test('the release job tears the keychain down before the smoke gate', () => {
    const names = stepNames(desktopRelease);
    const teardown = indexOfStep(names, 'Remove signing keychain');
    expect(teardown).toBeGreaterThan(indexOfStep(names, 'Build + sign + notarize DMG/ZIP'));
    expect(teardown).toBeLessThan(indexOfStep(names, 'Smoke the packaged DMG'));
  });

  test('both jobs tear the keychain down right after the key removal, even on failure', () => {
    for (const job of macPackagingJobs) {
      const teardown = macStepIndex(job, 'Remove signing keychain');
      expect(
        teardown,
        `${job.label}: the keychain teardown must directly follow the key removal`,
      ).toBe(macStepIndex(job, 'Remove App Store Connect API key') + 1);
      expect(job.steps[teardown].if).toBe('always()');
    }
  });
});

describe('the App Store Connect key exists on disk only for packaging', () => {
  const MATERIALIZE = 'Materialize App Store Connect API key';
  const REMOVE = 'Remove App Store Connect API key';
  const keyPath = (job) => {
    const match = /^\s*KEY_PATH="([^"]+)"$/m.exec(job.steps[macStepIndex(job, MATERIALIZE)].run);
    if (!match) throw new Error(`${job.label}: ${MATERIALIZE} no longer assigns KEY_PATH`);
    return match[1];
  };

  test('the key is materialized after the unsigned build steps, immediately before the packager', () => {
    for (const job of macPackagingJobs) {
      const materialize = macStepIndex(job, MATERIALIZE);
      for (const name of macStepsBeforeSigning(job)) {
        expect(materialize, `${job.label}: ${MATERIALIZE} must follow ${name}`).toBeGreaterThan(
          macStepIndex(job, name),
        );
      }
      expect(materialize, `${job.label}: ${MATERIALIZE} must directly precede the packager`).toBe(
        macStepIndex(job, job.packager) - 1,
      );
    }
  });

  test('the step right after the packager removes the key at the path it was materialized to, even on failure', () => {
    for (const job of macPackagingJobs) {
      const remove = macStepIndex(job, REMOVE);
      expect(remove, `${job.label}: ${REMOVE} must directly follow the packager`).toBe(
        macStepIndex(job, job.packager) + 1,
      );
      expect(job.steps[remove].run).toContain(`rm -f "${keyPath(job)}"`);
      expect(job.steps[remove].if).toBe('always()');
    }
  });

  test('the release job removes the key before the smoke gate launches the packaged app', () => {
    const [release] = macPackagingJobs;
    expect(macStepIndex(release, REMOVE)).toBeLessThan(
      macStepIndex(release, 'Smoke the packaged DMG (FR5b)'),
    );
  });
});

describe('public desktop product variants stay independently buildable', () => {
  const desktopBuild = read('desktop-build.yml');

  test('manual public packaging workflows expose Stable and Beta only', () => {
    for (const workflow of [desktopBuild, desktopBuildWinLinux]) {
      expect(workflow).toContain('options: [stable, beta]');
      expect(workflow).toContain('OK_DESKTOP_VARIANT:');
    }
  });

  test('every manual public packaging call runs the wrapper under pnpm exec', () => {
    for (const workflow of [desktopBuild, desktopBuildWinLinux]) {
      const calls = workflow
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('#'))
        .filter((line) => /--publish |(?:run-electron-builder|package-desktop)\.mjs/.test(line));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(
          /^pnpm exec node "\$GITHUB_WORKSPACE\/\.github\/scripts\/package-desktop\.mjs" --/,
        );
      }
    }
  });

  test('the release workflow maps public product tags to disjoint updater channels', () => {
    for (const pair of [
      ['*-beta.*', 'artifact_name=OpenKnowledge-Beta'],
      ['channel=latest', 'artifact_name=OpenKnowledge'],
    ]) {
      expect(desktopRelease).toContain(pair[0]);
      expect(desktopRelease).toContain(pair[1]);
    }
    expect(desktopRelease).toContain('ARTIFACT_NAME: ${{ needs.prepare.outputs.artifact_name }}');
    expect(desktopRelease).toContain('${artifact}-${VERSION}-arm64-mac.zip');
  });

  test('signed Beta builds require their own provisioning profile', () => {
    for (const workflow of [desktopBuild, desktopRelease]) {
      expect(workflow).toContain('embedded.${OK_DESKTOP_VARIANT}.provisionprofile');
      expect(workflow).toContain('security cms -D -i "$PROFILE_PATH"');
    }
  });

  test('the fast-tier smoke resolves the candidate inventory, including legacy Beta artifacts', () => {
    expect(selectBeta).toContain('node .github/scripts/download-candidate-dmg.mjs');
    expect(selectBeta).toContain('DMG: ${{ steps.download.outputs.dmg_path }}');
    expect(selectBeta).not.toContain("--pattern 'OpenKnowledge-Beta-*.dmg'");
  });
});

describe('the macOS artifact is attested signed before it can ship', () => {
  const desktopBuild = read('desktop-build.yml');
  const ATTEST = 'Attest the signed macOS app';

  test('the attestation sits between the packager and the smoke gate on the release path', () => {
    const names = stepNames(desktopRelease);
    const attest = indexOfStep(names, ATTEST);
    expect(attest).toBeGreaterThan(indexOfStep(names, 'Build + sign + notarize DMG/ZIP'));
    expect(attest).toBeLessThan(indexOfStep(names, 'Smoke the packaged DMG'));
    const step = workflowStep(desktopRelease, 'desktop-release.yml', ATTEST);
    expect(stepLevelIfConditions(step)).toEqual([]);
  });

  test('both workflows check the Developer ID chain, hardened runtime, and the stapled ticket', () => {
    for (const [source, name] of [
      [desktopRelease, 'desktop-release.yml'],
      [desktopBuild, 'desktop-build.yml'],
    ]) {
      const step = workflowStep(source, name, ATTEST);
      expect(step).toContain('codesign --verify --deep --strict');
      expect(step).toContain("'Authority=Developer ID Application'");
      expect(step).toContain('runtime');
      expect(step).toContain('xcrun stapler validate "$APP"');
      expect(step).toContain('No .app found under dist-desktop to attest');
    }
  });
});

describe('every job that reads changesets installs the Changesets reader first', () => {
  const OK_ROOT = join(WORKFLOWS, '..', '..');
  const READER = join(OK_ROOT, 'scripts', 'compute-next-beta.mjs');
  const importsReader = (file, seen = new Set()) => {
    if (file === READER) return true;
    if (seen.has(file) || !existsSync(file)) return false;
    seen.add(file);
    return [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)].some(([, spec]) =>
      importsReader(resolve(dirname(file), spec), seen),
    );
  };
  const VERDICT_MODE_SCRIPTS = new Set([
    join(OK_ROOT, 'scripts', 'compute-stable-version.mjs'),
    join(OK_ROOT, '.github', 'scripts', 'point-release-plan.mjs'),
    join(OK_ROOT, '.github', 'scripts', 'bug-lane.mjs'),
    join(OK_ROOT, '.github', 'scripts', 'select-beta-to-promote.mjs'),
  ]);
  const readsChangesets = (step) => {
    const readers = [...(step.run ?? '').matchAll(/[\w./-]+\.mjs\b/g)]
      .map(([path]) => resolve(OK_ROOT, path))
      .filter((file) => importsReader(file));
    if (readers.length === 0) return false;
    return step.env?.BUMP_VERDICTS === undefined || readers.some((file) => !VERDICT_MODE_SCRIPTS.has(file));
  };
  const readerJobs = readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) =>
      Object.entries(parse(read(file)).jobs ?? {}).flatMap(([id, { steps = [] }]) => {
        const readAt = steps.findIndex(readsChangesets);
        return readAt === -1 ? [] : [{ job: `${file}#${id}`, before: steps.slice(0, readAt) }];
      }),
    );

  test('the sweep finds every job that runs a version script', () => {
    expect(readerJobs.map(({ job }) => job)).toEqual(
      expect.arrayContaining([
        'bug-lane.yml#read-bumps',
        'point-release.yml#read-bumps',
        'promote-stable.yml#read-bumps',
        'release.yml#build',
        'select-beta-to-promote.yml#read-bumps',
      ]),
    );
  });

  test('each one runs pnpm install before its first read', () => {
    const uninstalled = readerJobs
      .filter(({ before }) => !before.some((step) => /\bpnpm install\b/.test(step.run ?? '')))
      .map(({ job }) => job);
    expect(uninstalled).toEqual([]);
  });

  test('BUMP_VERDICTS exempts only a script that implements verdict mode', () => {
    const env = { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.bump_verdicts }}' };
    expect(readsChangesets({ env, run: 'node scripts/compute-stable-version.mjs "$BETA_TAG"' })).toBe(false);
    expect(readsChangesets({ env, run: 'node .github/scripts/point-release-plan.mjs' })).toBe(false);
    expect(readsChangesets({ env, run: 'node scripts/compute-next-beta.mjs' })).toBe(true);
    expect(
      readsChangesets({ env, run: 'node scripts/compute-stable-version.mjs v1\nnode scripts/compute-next-beta.mjs' }),
    ).toBe(true);
    expect(readsChangesets({ run: 'node scripts/compute-stable-version.mjs "$BETA_TAG"' })).toBe(true);
  });
});

describe('the release App credential never shares a job with installed packages', () => {
  const OK_ROOT = join(WORKFLOWS, '..', '..');
  const credentialWorkflows = ['point-release.yml', 'promote-stable.yml'];
  const jobs = credentialWorkflows.flatMap((file) =>
    Object.entries(parse(read(file)).jobs).map(([id, job]) => ({ name: `${file}#${id}`, job })),
  );
  const steps = (job) => job.steps ?? [];
  const commands = (step) =>
    (step.run ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
  const COMMAND_START = '(?:^|[;&|({`])';
  const COMMAND_PREFIX =
    '(?:if|elif|then|do|else|while|until|!|(?:exec|sudo|xargs|env|time|nohup|command)(?:\\s+-\\S+)*|timeout(?:\\s+-\\S+)*\\s+\\S+|[A-Za-z_]\\w*=\\S*)';
  const PACKAGE_RUNNER = '(?:pnpm|pnpx|npm|npx|yarn|bun|bunx|corepack)\\b';
  const PACKAGE_COMMAND = new RegExp(`${COMMAND_START}\\s*(?:${COMMAND_PREFIX}\\s+)*${PACKAGE_RUNNER}`, 'm');
  const PACKAGE_FREE_ACTIONS = [
    'actions/checkout@',
    'actions/setup-node@',
    'actions/create-github-app-token@',
    'actions/upload-artifact@',
  ];
  const compositeSteps = (uses, root) => {
    const dir = join(root, uses);
    const file = ['action.yml', 'action.yaml'].map((name) => join(dir, name)).find((path) => existsSync(path));
    if (!file) throw new Error(`local action ${uses} has no action.yml`);
    const action = parse(readFileSync(file, 'utf8'));
    return action.runs?.using === 'composite' ? action.runs.steps : null;
  };
  const packageRoutes = (stepList, root = OK_ROOT, seen = new Set()) =>
    stepList.flatMap((step) => {
      const routes = PACKAGE_COMMAND.test(commands(step)) ? [step.name ?? step.run] : [];
      if (step.uses?.startsWith('./')) {
        if (seen.has(step.uses)) return routes;
        const inner = compositeSteps(step.uses, root);
        return inner === null
          ? [...routes, step.uses]
          : [...routes, ...packageRoutes(inner, root, new Set([...seen, step.uses])).map((r) => `${step.uses} > ${r}`)];
      }
      if (step.uses && !PACKAGE_FREE_ACTIONS.some((prefix) => step.uses.startsWith(prefix))) {
        return [...routes, step.uses];
      }
      return routes;
    });
  const installs = (job) => packageRoutes(steps(job)).length > 0;
  const mintsAppToken = (job) =>
    steps(job).some((step) => step.uses?.startsWith('actions/create-github-app-token@'));

  const REFUSAL = 'Refuse bumps read for a different beta';
  const expressions = (value, path = []) => {
    if (typeof value === 'string') {
      if (path.at(-1) === 'if') return [{ path, expr: value.trim() }];
      return [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(([, body]) => ({ path, expr: body.trim() }));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, item]) => expressions(item, [...path, key]));
    }
    return [];
  };
  const isSanctionedRead = (job, { path, expr }) => {
    if (path[0] !== 'steps' || path[2] !== 'env') return false;
    if (path[3] === 'BUMP_VERDICTS') return expr === 'needs.read-bumps.outputs.bump_verdicts';
    return (
      path[3] === 'READ_BUMPS_BETA_TAG' &&
      job.steps[path[1]]?.name === REFUSAL &&
      expr === 'needs.read-bumps.outputs.beta_tag'
    );
  };
  const strayReaderReads = (job) =>
    expressions(job)
      .filter((found) => /\bneeds\b/.test(found.expr) && !isSanctionedRead(job, found))
      .map(({ path, expr }) => `${path.join('.')}: ${expr}`);

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'release-cascade-local-actions-'));
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const localAction = (name, action, file = 'action.yml') => {
    const dir = join(fixtureRoot, '.github', 'actions', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(action));
    return `./.github/actions/${name}`;
  };
  const composite = (...actionSteps) => ({ name: 'fixture', runs: { using: 'composite', steps: actionSteps } });
  const INSTALLING_COMPOSITE = localAction(
    'installs',
    composite({ name: 'Install', shell: 'bash', run: 'pnpm install --frozen-lockfile' }),
  );
  const NESTED_COMPOSITE = localAction('nested', composite({ name: 'Inner', uses: INSTALLING_COMPOSITE }));
  const PACKAGE_FREE_COMPOSITE = localAction(
    'package-free',
    composite({ name: 'Probe', shell: 'bash', run: 'node scripts/probe.mjs' }, { uses: 'actions/setup-node@v6' }),
  );
  const NODE_ACTION = localAction('node-action', { name: 'fixture', runs: { using: 'node24', main: 'index.js' } });
  const LOOPING_COMPOSITE = localAction('loop', composite({ name: 'Self', uses: './.github/actions/loop' }));
  const YAML_SPELLED_COMPOSITE = localAction(
    'yaml-spelled',
    composite({ name: 'Install', shell: 'bash', run: 'npm ci' }),
    'action.yaml',
  );

  test('the package-route detector bites on every form that would reopen the exposure', () => {
    const job = (step) => ({ steps: [step] });
    for (const run of [
      'pnpm install --frozen-lockfile',
      'pnpm --filter=. install --ignore-scripts',
      'pnpm -r install',
      'set -e; npm ci',
      'cd x && npx some-tool',
      'corepack enable',
      'FOO=1 pnpm exec vitest',
      'out=$(yarn add left-pad)',
      'if pnpm install; then echo ok; fi',
      'if ! npm ci; then exit 1; fi',
      'if true; then :; elif npm ci; then :; fi',
      'while ! pnpm install; do sleep 5; done',
      'until pnpm install; do sleep 5; done',
      '! npm ci',
      '{ pnpm install; }',
      'time pnpm install',
      'time -p npm ci',
      'timeout 300 pnpm install',
      'timeout --signal=KILL 300 npm ci',
      'nohup pnpm install &',
      'command pnpm install',
      'if ! timeout 300 pnpm install; then exit 1; fi',
      'if x; then pnpm install; fi',
      'for a in b; do npm ci; done',
      'if x; then :; else npm ci; fi',
      'exec pnpm install',
      'sudo npm ci',
      'echo a | xargs npm install',
      'env npm ci',
      'echo y | npx some-tool',
      '(npm ci)',
      'out=`npm ci`',
      'pnpx some-tool',
      'bun install',
      'bunx some-tool',
      'set -e\npnpm install',
    ]) {
      expect(installs(job({ run })), run).toBe(true);
    }
    expect(installs(job({ uses: 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86' }))).toBe(true);
    for (const run of [
      'node scripts/compute-stable-version.mjs "$BETA_TAG"',
      'echo "dispatches publish-stable to release.yml for npm. npm latest does NOT move"',
      '# pnpm exec changeset version runs in main-reset',
      '  # if ! timeout 300 pnpm install; then exit 1; fi',
      '# x; pnpm install',
      '  # x; pnpm install',
      'bunyan --version',
    ]) {
      expect(installs(job({ run })), run).toBe(false);
    }
    for (const uses of [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
      'actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]) {
      expect(installs(job({ uses })), uses).toBe(false);
    }
  });

  test('the detector reads local actions from their action.yml, through nested composites', () => {
    const routes = (uses) => packageRoutes([{ name: 'Use it', uses }], fixtureRoot);
    expect(routes(INSTALLING_COMPOSITE)).toEqual([`${INSTALLING_COMPOSITE} > Install`]);
    expect(routes(NESTED_COMPOSITE)).toEqual([`${NESTED_COMPOSITE} > ${INSTALLING_COMPOSITE} > Install`]);
    expect(routes(NODE_ACTION)).toEqual([NODE_ACTION]);
    expect(routes(PACKAGE_FREE_COMPOSITE)).toEqual([]);
    expect(routes(LOOPING_COMPOSITE)).toEqual([]);
    expect(routes(YAML_SPELLED_COMPOSITE)).toEqual([`${YAML_SPELLED_COMPOSITE} > Install`]);
    expect(() => routes('./.github/actions/absent')).toThrow('local action ./.github/actions/absent has no action.yml');
  });

  test('each workflow has exactly one job that installs and one that mints, and they differ', () => {
    for (const file of credentialWorkflows) {
      const own = jobs.filter(({ name }) => name.startsWith(`${file}#`));
      const installers = own.filter(({ job }) => installs(job)).map(({ name }) => name);
      const minters = own.filter(({ job }) => mintsAppToken(job)).map(({ name }) => name);
      expect(installers, file).toHaveLength(1);
      expect(minters, file).toHaveLength(1);
      expect(installers[0], file).not.toBe(minters[0]);
    }
  });

  test('a job that installs packages references no secret and holds a read-only GITHUB_TOKEN', () => {
    for (const { name, job } of jobs.filter(({ job }) => installs(job))) {
      expect(JSON.stringify(job), name).not.toMatch(/secrets\.|create-github-app-token|app-token|bridge-token/);
      expect(job.permissions, name).toEqual({ contents: 'read' });
    }
  });

  test('a job that mints an App token has no package route, local composite actions included', () => {
    for (const { name, job } of jobs.filter(({ job }) => mintsAppToken(job))) {
      expect(packageRoutes(steps(job)), name).toEqual([]);
      expect(job.needs, name).toBe('read-bumps');
    }
  });

  test('the reader-output scan sees every way a job can read read-bumps', () => {
    const verdictStep = {
      name: 'Compute',
      env: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.bump_verdicts }}' },
      run: 'node scripts/compute-stable-version.mjs "$BETA_TAG"',
    };
    const refusal = {
      name: REFUSAL,
      env: {
        RESOLVED: '${{ steps.resolve.outputs.beta_tag }}',
        READ_BUMPS_BETA_TAG: '${{ needs.read-bumps.outputs.beta_tag }}',
      },
      run: 'test "$RESOLVED" = "$READ_BUMPS_BETA_TAG"',
    };
    const prose = { name: 'Announce', run: 'echo "the release needs a published beta"' };
    const sanctioned = { needs: 'read-bumps', steps: [verdictStep, refusal, prose] };
    expect(strayReaderReads(sanctioned)).toEqual([]);
    const withStep = (step) => ({ ...sanctioned, steps: [verdictStep, refusal, { name: 'Stray', ...step }] });
    const withRefusalEnv = (env) => ({ ...sanctioned, steps: [verdictStep, { ...refusal, env: { ...refusal.env, ...env } }] });
    const strays = {
      'job-level env': { ...sanctioned, env: { BETA_TAG: '${{ needs.read-bumps.outputs.beta_tag }}' } },
      'job-level if': { ...sanctioned, if: "needs.read-bumps.outputs.beta_tag != ''" },
      'job-level outputs': { ...sanctioned, outputs: { beta: '${{ needs.read-bumps.outputs.beta_tag }}' } },
      'job-level name': { ...sanctioned, name: 'Promote ${{ needs.read-bumps.outputs.beta_tag }}' },
      'single-quoted index': withStep({ env: { B: "${{ needs['read-bumps'].outputs['beta_tag'] }}" } }),
      'double-quoted index': withStep({ env: { B: '${{ needs["read-bumps"].outputs["beta_tag"] }}' } }),
      'whole needs object': withStep({ run: 'echo ${{ toJSON(needs) }}' }),
      'whole outputs object': withStep({ env: { O: '${{ toJSON(needs.read-bumps.outputs) }}' } }),
      'whole job by index': withStep({ env: { O: "${{ toJSON(needs['read-bumps']) }}" } }),
      'step-level if': withStep({ if: "needs.read-bumps.outputs.beta_tag == 'v1.0.0-beta.1'" }),
      'expression inside a run block': withStep({ run: 'git tag x "${{ needs.read-bumps.outputs.beta_tag }}"' }),
      'bump_verdicts outside BUMP_VERDICTS': withStep({ env: { V: '${{ needs.read-bumps.outputs.bump_verdicts }}' } }),
      'beta_tag outside the refusal step': withStep({
        env: { READ_BUMPS_BETA_TAG: '${{ needs.read-bumps.outputs.beta_tag }}' },
      }),
      'the refusal step reading another expression': withRefusalEnv({
        READ_BUMPS_BETA_TAG: '${{ toJSON(needs.read-bumps.outputs) }}',
      }),
      'the refusal step reading beta_tag under another name': withRefusalEnv({
        ALSO_BETA_TAG: '${{ needs.read-bumps.outputs.beta_tag }}',
      }),
      'BUMP_VERDICTS reading another output': withStep({
        env: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.beta_tag }}' },
      }),
      'an action input named BUMP_VERDICTS': withStep({
        uses: './.github/actions/consumer',
        with: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.bump_verdicts }}' },
      }),
      'a service container env named BUMP_VERDICTS': {
        ...sanctioned,
        services: { cache: { image: 'redis:7', env: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.bump_verdicts }}' } } },
      },
    };
    for (const [form, job] of Object.entries(strays)) {
      expect(strayReaderReads(job), form).not.toEqual([]);
    }
  });

  test('a job that mints an App token takes only bump_verdicts from the reader job', () => {
    for (const { name, job } of jobs.filter(({ job }) => mintsAppToken(job))) {
      const verdictSteps = steps(job).filter((step) => step.env?.BUMP_VERDICTS !== undefined);
      expect(verdictSteps.length, name).toBeGreaterThan(0);
      for (const step of verdictSteps) {
        expect(step.env.BUMP_VERDICTS, `${name} ${step.name}`).toBe(
          '${{ needs.read-bumps.outputs.bump_verdicts }}',
        );
      }
      expect(strayReaderReads(job), name).toEqual([]);
      for (const step of steps(job).filter((candidate) => candidate.name === REFUSAL)) {
        expect(step.id, name).toBeUndefined();
        expect(step.if, name).toBeUndefined();
        expect(commands(step), name).toMatch(/if \[\[ "\$RESOLVED" != "\$READ_BUMPS_BETA_TAG" \]\]; then[\s\S]*exit 1/);
        expect(commands(step), name).toMatch(/Re-run all jobs/);
        expect(commands(step), name).toMatch(/explicit beta_tag/);
      }
    }
  });

  test('no checkout in either workflow persists a credential or receives an App token', () => {
    const checkouts = jobs.flatMap(({ name, job }) =>
      steps(job)
        .filter((step) => step.uses?.startsWith('actions/checkout@'))
        .map((step) => ({ name, step })),
    );
    expect(checkouts.length).toBe(4);
    for (const { name, step } of checkouts) {
      expect(step.with?.['persist-credentials'], name).toBe(false);
      expect(step.with?.token, name).toBeUndefined();
    }
  });

  describe('the Linear key, Slack webhooks and write tokens never share a job with installed packages', () => {
    const readerWorkflows = {
      'bug-lane.yml': ['read-bumps'],
      'select-beta-to-promote.yml': ['read-bumps', 'smoke-fast-tier-candidate', 'read-smoke-incident'],
    };
    const PINNED_CACHE_SAVE = /^actions\/cache\/save@[0-9a-f]{40}$/;
    const PINNED_CACHE_RESTORE = /^actions\/cache\/restore@[0-9a-f]{40}$/;
    const extractsNothing = (step) =>
      PINNED_CACHE_SAVE.test(step.uses ?? '') ||
      (PINNED_CACHE_RESTORE.test(step.uses ?? '') && String(step.with?.['lookup-only']) === 'true');
    const SETUP_NODE = /^actions\/setup-node@/;
    const setupNodeRestoresNothing = (step) =>
      step.with?.cache === undefined && /^false$/i.test(String(step.with?.['package-manager-cache']));
    const routesOf = (job) => {
      const kept = steps(job).filter((step) => !extractsNothing(step));
      return [
        ...packageRoutes(kept),
        ...kept.filter((step) => SETUP_NODE.test(step.uses ?? '') && !setupNodeRestoresNothing(step)).map((step) => step.uses),
      ];
    };
    const SANCTIONED_IF =
      /^(?:always\(\) && )?needs\.smoke-fast-tier-candidate\.outputs\.verdict == '(?:pass|fail)'$/;
    const readerOutputReads = (job, readers) => {
      const others = new RegExp(
        `\\bneeds\\.(?!(?:${readers.join('|')})\\.)[A-Za-z_][\\w-]*\\.outputs\\.[A-Za-z_][\\w-]*`,
        'g',
      );
      return expressions(job)
        .filter(({ path, expr }) => {
          if (!/\bneeds\b/.test(expr)) return false;
          if (path.length === 1 && path[0] === 'if' && SANCTIONED_IF.test(expr)) return false;
          if (path[0] === 'steps' && path[2] === 'env' && path[3] === 'BUMP_VERDICTS' && path.length === 4) {
            return expr !== 'needs.read-bumps.outputs.bump_verdicts';
          }
          if (path[0] === 'steps' && path[2] === 'env' && path[3] === 'ALERT_STATE' && path.length === 4) {
            return expr !== 'needs.read-smoke-incident.outputs.state';
          }
          return /\bneeds\b/.test(expr.replace(others, ''));
        })
        .map(({ path, expr }) => `${path.join('.')}: ${expr}`);
    };
    const all = Object.entries(readerWorkflows).flatMap(([file, readers]) => {
      const workflow = parse(read(file));
      return Object.entries(workflow.jobs).map(([id, job]) => ({ file, id, job, workflow, readers }));
    });

    test('the jobs with a package route or a cache extraction are exactly the reader jobs, one per role', () => {
      for (const [file, readers] of Object.entries(readerWorkflows)) {
        const installers = all.filter((j) => j.file === file && routesOf(j.job).length > 0).map((j) => j.id);
        expect(installers, file).toEqual(readers);
      }
    });

    test('a job with a package route or a cache extraction references no secret but GITHUB_TOKEN and holds no write scope', () => {
      const installers = all.filter(({ job }) => routesOf(job).length > 0);
      expect(installers.length).toBe(4);
      for (const { file, id, job, workflow } of installers) {
        expect(job.permissions, `${file}#${id}`).toBeDefined();
        expect(credentialReasons(workflow, job), `${file}#${id}`).toEqual([]);
      }
    });

    test('every job that holds a credential has no package route and extracts no cache entry', () => {
      const holders = all.filter(({ workflow, job }) => holdsCredential(workflow, job)).map(({ file, id }) => `${file}#${id}`);
      expect(holders).toEqual([
        'bug-lane.yml#bug-lane',
        'select-beta-to-promote.yml#evaluate',
        'select-beta-to-promote.yml#dispatch-fast-tier-candidate',
        'select-beta-to-promote.yml#page-smoke-incident',
      ]);
      for (const { file, id, job } of all.filter((j) => holdsCredential(j.workflow, j.job))) {
        expect(routesOf(job), `${file}#${id}`).toEqual([]);
      }
    });

    test('the token scopes of every job are pinned, with the alarm read-only and the failure marker empty', () => {
      const effective = Object.fromEntries(
        all.map(({ file, id, job, workflow }) => [`${file}#${id}`, job.permissions ?? workflow.permissions]),
      );
      const dispatcher = { contents: 'read', actions: 'write' };
      const reader = { contents: 'read' };
      expect(effective).toEqual({
        'bug-lane.yml#read-bumps': reader,
        'bug-lane.yml#bug-lane': dispatcher,
        'select-beta-to-promote.yml#read-bumps': reader,
        'select-beta-to-promote.yml#evaluate': dispatcher,
        'select-beta-to-promote.yml#smoke-fast-tier-candidate': reader,
        'select-beta-to-promote.yml#dispatch-fast-tier-candidate': dispatcher,
        'select-beta-to-promote.yml#remember-smoke-failure': {},
        'select-beta-to-promote.yml#aggregate-smoke-alarm': { contents: 'read', actions: 'read' },
        'select-beta-to-promote.yml#read-smoke-incident': {},
        'select-beta-to-promote.yml#page-smoke-incident': reader,
      });
    });

    test('the only actions excused from the route sweep are a pinned cache save and a pinned lookup-only restore', () => {
      const sha = '668228422ae6a00e4ad889ee87cd7109ec5666a7';
      const restore = `actions/cache/restore@${sha}`;
      const path = 'smoke-incident.json';
      const excused = {
        'a pinned save': { uses: `actions/cache/save@${sha}`, with: { path, key: 'k' } },
        'a pinned lookup-only restore': { uses: restore, with: { path, key: 'k', 'lookup-only': true } },
        'a pinned lookup-only restore spelled as a string': { uses: restore, with: { path, key: 'k', 'lookup-only': 'true' } },
      };
      for (const [form, step] of Object.entries(excused)) {
        expect(routesOf({ steps: [step] }), form).toEqual([]);
      }
      const extracting = {
        'a pinned restore that extracts': { uses: restore, with: { path, key: 'k', 'restore-keys': 'k-' } },
        'a pinned restore with lookup-only false': { uses: restore, with: { path, key: 'k', 'lookup-only': false } },
        'a pinned restore whose lookup-only is an expression': {
          uses: restore,
          with: { path, key: 'k', 'lookup-only': '${{ inputs.lookup }}' },
        },
        'the combined cache action, which restores and extracts': { uses: `actions/cache@${sha}`, with: { path, key: 'k' } },
        'the combined cache action with lookup-only': { uses: `actions/cache@${sha}`, with: { path, key: 'k', 'lookup-only': true } },
        'an unpinned save': { uses: 'actions/cache/save@v5', with: { path, key: 'k' } },
        'an unpinned lookup-only restore': { uses: 'actions/cache/restore@v5', with: { path, key: 'k', 'lookup-only': true } },
        'a lookalike lookup-only restore': { uses: `someone/cache/restore@${sha}`, with: { path, key: 'k', 'lookup-only': true } },
        'a package installer action': { uses: 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86' },
      };
      for (const [form, step] of Object.entries(extracting)) {
        expect(routesOf({ steps: [step] }), form).toEqual([step.uses]);
      }
      expect(routesOf({ steps: [excused['a pinned save'], { name: 'Install', run: 'pnpm install' }] })).toEqual(['Install']);
    });

    test('a setup-node step counts as a cache extraction unless it names no cache and turns the package-manager cache off', () => {
      const uses = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
      const extracting = {
        'a cache input': { uses, with: { 'node-version': '24', cache: 'pnpm' } },
        'no inputs at all': { uses },
        'only a node version': { uses, with: { 'node-version': '24' } },
        'package-manager-cache set by an expression': {
          uses,
          with: { 'node-version': '24', 'package-manager-cache': '${{ inputs.package-manager-cache }}' },
        },
        'package-manager-cache true': { uses, with: { 'node-version': '24', 'package-manager-cache': true } },
        'package-manager-cache spelled as the string true': { uses, with: { 'node-version': '24', 'package-manager-cache': 'true' } },
        'a cache input beside package-manager-cache false': {
          uses,
          with: { 'node-version': '24', cache: 'pnpm', 'package-manager-cache': false },
        },
        'an unpinned setup-node with a cache input': { uses: 'actions/setup-node@v6', with: { cache: 'npm' } },
      };
      for (const [form, step] of Object.entries(extracting)) {
        expect(routesOf({ steps: [step] }), form).toEqual([step.uses]);
      }
      const excused = {
        'no cache input and package-manager-cache false': { uses, with: { 'node-version': '24', 'package-manager-cache': false } },
        'the same, spelled as a string': { uses, with: { 'node-version': '24', 'package-manager-cache': 'false' } },
        'the same, in capitals': { uses, with: { 'node-version': '24', 'package-manager-cache': 'FALSE' } },
      };
      for (const [form, step] of Object.entries(excused)) {
        expect(routesOf({ steps: [step] }), form).toEqual([]);
      }
    });

    test('each reader job hands on only the one output its consumers need', () => {
      const outputs = all
        .filter(({ job }) => routesOf(job).length > 0)
        .map(({ file, id, job }) => [`${file}#${id}`, Object.keys(job.outputs ?? {})]);
      expect(Object.fromEntries(outputs)).toEqual({
        'bug-lane.yml#read-bumps': ['bump_verdicts'],
        'select-beta-to-promote.yml#read-bumps': ['bump_verdicts'],
        'select-beta-to-promote.yml#smoke-fast-tier-candidate': ['verdict'],
        'select-beta-to-promote.yml#read-smoke-incident': ['state'],
      });
    });

    test('a job that runs no package code takes only bump_verdicts, the smoke verdict and the acknowledgement from a reader job', () => {
      for (const { file, id, job, readers } of all.filter((j) => routesOf(j.job).length === 0)) {
        expect(readerOutputReads(job, readers), `${file}#${id}`).toEqual([]);
        for (const step of steps(job).filter((s) => s.env?.BUMP_VERDICTS !== undefined)) {
          expect(step.env.BUMP_VERDICTS, `${file}#${id}`).toBe('${{ needs.read-bumps.outputs.bump_verdicts }}');
        }
      }
      const consumers = all
        .filter(({ job, readers }) =>
          expressions(job).some(({ expr }) => readers.some((reader) => expr.includes(`needs.${reader}.`))),
        )
        .filter(({ job }) => routesOf(job).length === 0)
        .map(({ file, id }) => `${file}#${id}`);
      expect(consumers).toEqual([
        'bug-lane.yml#bug-lane',
        'select-beta-to-promote.yml#evaluate',
        'select-beta-to-promote.yml#dispatch-fast-tier-candidate',
        'select-beta-to-promote.yml#remember-smoke-failure',
        'select-beta-to-promote.yml#page-smoke-incident',
      ]);
      const [write] = steps(parse(selectBeta).jobs['page-smoke-incident']).filter((s) => s.env?.ALERT_STATE !== undefined);
      expect(write.env.ALERT_STATE).toBe('${{ needs.read-smoke-incident.outputs.state }}');
    });

    test('the credential classifier sees every way a job can hold one', () => {
      const workflow = { permissions: { contents: 'read' } };
      const readOnly = { permissions: { contents: 'read' } };
      const step = (env) => ({ steps: [{ run: 'true', env }] });
      expect(holdsCredential(workflow, { ...readOnly, ...step({ GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }) })).toBe(false);
      expect(holdsCredential(workflow, { ...readOnly, ...step({ GH_TOKEN: '${{ github.token }}' }) })).toBe(false);
      const holders = {
        'a write permission': { permissions: { contents: 'read', actions: 'write' } },
        'write-all': { permissions: 'write-all' },
        'a workflow-level write it inherits': [{ permissions: { actions: 'write' } }, {}],
        'no permissions anywhere': [{}, {}],
        'a named secret in a step env': { ...readOnly, ...step({ KEY: '${{ secrets.LINEAR_API_KEY }}' }) },
        'an indexed secret': { ...readOnly, ...step({ KEY: "${{ secrets['SLACK_WEBHOOK_URL'] }}" }) },
        'every secret': { ...readOnly, ...step({ ALL: '${{ toJSON(secrets) }}' }) },
        'a secret in a run block': { ...readOnly, steps: [{ run: 'curl -d x "${{ secrets.SLACK_WEBHOOK_URL }}"' }] },
        'a secret in an action input': { ...readOnly, steps: [{ uses: 'x/y@v1', with: { token: '${{ secrets.APP_KEY }}' } }] },
        'a secret in job-level env': { ...readOnly, env: { KEY: '${{ secrets.LINEAR_API_KEY }}' } },
        'a secret in workflow-level env': [{ ...workflow, env: { KEY: '${{ secrets.LINEAR_API_KEY }}' } }, readOnly],
        'a secret in a bare if': { ...readOnly, steps: [{ if: "secrets.SLACK_WEBHOOK_URL != ''", run: 'true' }] },
        'id-token write': { permissions: { 'id-token': 'write' } },
        'an App token step': { ...readOnly, steps: [{ uses: 'actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3' }] },
        'inherited secrets on a reusable call': { ...readOnly, uses: './.github/workflows/x.yml', secrets: 'inherit' },
      };
      for (const [form, value] of Object.entries(holders)) {
        const [wf, job] = Array.isArray(value) ? value : [workflow, value];
        expect(holdsCredential(wf, job), form).toBe(true);
      }
    });

    test('the reader-output scan sees every way a credentialed job can read a reader job', () => {
      const readers = ['read-bumps', 'smoke-fast-tier-candidate', 'read-smoke-incident'];
      const verdictStep = {
        name: 'Select',
        env: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.bump_verdicts }}', LINEAR_API_KEY: '${{ secrets.LINEAR_API_KEY }}' },
        run: 'node .github/scripts/select-beta-to-promote.mjs',
      };
      const candidateStep = { name: 'Dispatch', env: { CANDIDATE: '${{ needs.evaluate.outputs.fast_tier_candidate }}' }, run: 'gh workflow run x' };
      const stateStep = {
        name: 'Write',
        env: { ALERT_STATE: '${{ needs.read-smoke-incident.outputs.state }}', ALERT_STATE_PATH: 'state.json' },
        run: 'printf "%s" "$ALERT_STATE" > "$ALERT_STATE_PATH"',
      };
      const sanctioned = {
        if: "needs.smoke-fast-tier-candidate.outputs.verdict == 'pass'",
        steps: [verdictStep, candidateStep, stateStep],
      };
      expect(readerOutputReads(sanctioned, readers)).toEqual([]);
      expect(readerOutputReads({ ...sanctioned, if: "always() && needs.smoke-fast-tier-candidate.outputs.verdict == 'fail'" }, readers)).toEqual([]);
      const withStep = (stray) => ({ ...sanctioned, steps: [verdictStep, candidateStep, stateStep, { name: 'Stray', ...stray }] });
      const strays = {
        'another read-bumps output': withStep({ env: { X: '${{ needs.read-bumps.outputs.beta_tag }}' } }),
        'bump_verdicts under another name': withStep({ env: { V: '${{ needs.read-bumps.outputs.bump_verdicts }}' } }),
        'BUMP_VERDICTS reading another output': withStep({ env: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.other }}' } }),
        'BUMP_VERDICTS as an action input': withStep({ uses: 'x/y@v1', with: { BUMP_VERDICTS: '${{ needs.read-bumps.outputs.bump_verdicts }}' } }),
        'the smoke verdict in a step env': withStep({ env: { VERDICT: '${{ needs.smoke-fast-tier-candidate.outputs.verdict }}' } }),
        'the candidate from the smoke job': withStep({ env: { CANDIDATE: '${{ needs.smoke-fast-tier-candidate.outputs.candidate }}' } }),
        'a step-level if on the smoke verdict': withStep({ if: "needs.smoke-fast-tier-candidate.outputs.verdict == 'pass'" }),
        'a job-level if on another smoke output': { ...sanctioned, if: "needs.smoke-fast-tier-candidate.outputs.dmg == 'x'" },
        'a job-level if that widens the verdict test': { ...sanctioned, if: "needs.smoke-fast-tier-candidate.outputs.verdict != 'fail'" },
        'a reader job result': withStep({ if: "needs.read-bumps.result == 'success'" }),
        'whole needs object': withStep({ run: 'echo "${{ toJSON(needs) }}"' }),
        'indexed reader job': withStep({ env: { X: "${{ needs['read-bumps'].outputs['bump_verdicts'] }}" } }),
        'a reader output inside a run block': withStep({ run: 'echo "${{ needs.read-bumps.outputs.bump_verdicts }}"' }),
        'job-level env': { ...sanctioned, env: { X: '${{ needs.read-bumps.outputs.bump_verdicts }}' } },
        'job-level outputs': { ...sanctioned, outputs: { x: '${{ needs.smoke-fast-tier-candidate.outputs.verdict }}' } },
        'the acknowledgement under another name': withStep({ env: { STATE: '${{ needs.read-smoke-incident.outputs.state }}' } }),
        'the acknowledgement inside a run block': withStep({ run: 'echo "${{ needs.read-smoke-incident.outputs.state }}"' }),
        'ALERT_STATE reading another output': withStep({ env: { ALERT_STATE: '${{ needs.read-smoke-incident.outputs.other }}' } }),
        'ALERT_STATE as an action input': withStep({ uses: 'x/y@v1', with: { ALERT_STATE: '${{ needs.read-smoke-incident.outputs.state }}' } }),
        'the acknowledgement reader result': withStep({ if: "needs.read-smoke-incident.result == 'success'" }),
      };
      for (const [form, job] of Object.entries(strays)) {
        expect(readerOutputReads(job, readers), form).not.toEqual([]);
      }
    });

    test('no checkout in these workflows persists a credential', () => {
      const checkouts = all.flatMap(({ file, id, job }) =>
        steps(job)
          .filter((step) => step.uses?.startsWith('actions/checkout@'))
          .map((step) => ({ name: `${file}#${id}`, step })),
      );
      expect(checkouts.length).toBe(7);
      for (const { name, step } of checkouts) {
        expect(step.with?.['persist-credentials'], name).toBe(false);
        expect(step.with?.token, name).toBeUndefined();
      }
    });

    test('the fast-tier dispatch takes its candidate from the evaluate job and dispatches as before', () => {
      const { jobs: selectJobs } = parse(selectBeta);
      const dispatch = selectJobs['dispatch-fast-tier-candidate'];
      expect(dispatch.needs).toEqual(['evaluate', 'smoke-fast-tier-candidate']);
      const [step] = dispatch.steps.filter((s) => s.name === 'Dispatch promote-stable for the smoke-proven candidate');
      expect(step.env).toEqual({
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
        GH_REPO: '${{ github.repository }}',
        CANDIDATE: '${{ needs.evaluate.outputs.fast_tier_candidate }}',
      });
      expect(commands(step)).toContain('gh workflow run promote-stable.yml -f beta_tag="$CANDIDATE" -f dispatched_by="$SELF_URL"');
      expect(commands(step)).toMatch(/gh run list --workflow=promote-stable\.yml/);
    });
  });

  describe('release.yml keeps the OIDC publish permission and the write token out of every job that runs package code', () => {
    const releaseWorkflow = parse(read('release.yml'));
    const TARBALL_PUBLISH = 'npm publish "$TARBALL" --access public --tag "$TAG" --provenance --registry https://registry.npmjs.org/';
    const PUBLISHER_COMMANDS = new Set([
      'npm install -g npm@11.21.0',
      'pacote="$(npm root -g)/npm/node_modules/pacote"',
      'echo "npm $(npm --version)"',
      'if [[ "$(npm view "${PACKAGE_NAME}@${VERSION}" version 2>/dev/null || true)" == "$VERSION" ]]; then',
      TARBALL_PUBLISH,
    ]);
    const PUBLISHER_ACTIONS = ['actions/setup-node@', 'actions/download-artifact@'];
    const PACK_IF = "github.event.action == 'publish-stable' || steps.compute-beta.outputs.run_beta == 'true'";
    const RUN_IF = "github.event.action == 'publish-stable' || needs.build.outputs.run_beta == 'true'";
    const BETA_IF = "needs.build.outputs.run_beta == 'true'";

    const permissionsOf = (workflow, job) => job.permissions ?? workflow.permissions ?? 'write-all';
    const grants = (permissions) =>
      typeof permissions === 'string'
        ? permissions === 'read-all'
          ? []
          : [permissions]
        : Object.entries(permissions)
            .filter(([, level]) => level === 'write')
            .map(([scope]) => `${scope}: write`);
    const mintsOidc = (workflow, job) =>
      grants(permissionsOf(workflow, job)).some((grant) => grant === 'id-token: write' || grant === 'write-all');
    const credentialsOf = (workflow, job) => [
      ...grants(permissionsOf(workflow, job)),
      ...(JSON.stringify(job).match(/secrets\.\w+/g) ?? []),
      ...(mintsAppToken(job) ? ['App token'] : []),
    ];
    const publisherView = (step) =>
      step.run === undefined
        ? step
        : { ...step, run: step.run.split('\n').filter((line) => !PUBLISHER_COMMANDS.has(line.trim())).join('\n') };
    const releasePackageRoutes = (workflow, job) => {
      const publisher = mintsOidc(workflow, job);
      return packageRoutes(
        steps(job)
          .filter((step) => !(publisher && PUBLISHER_ACTIONS.some((prefix) => step.uses?.startsWith(prefix))))
          .map((step) => (publisher ? publisherView(step) : step)),
      );
    };
    const READS_RELEASES = /(^|[;&|({`\s])gh\s+release\s+(list|view)\b/m;
    const seesDraftReleases = (workflow, job) =>
      grants(permissionsOf(workflow, job)).some((grant) => grant === 'contents: write' || grant === 'write-all');
    const releaseViolations = (workflow) => {
      const jobs = Object.entries(workflow.jobs);
      const violations = [];
      for (const [id, job] of jobs) {
        const routes = releasePackageRoutes(workflow, job);
        const credentials = credentialsOf(workflow, job);
        if (routes.length > 0 && credentials.length > 0) {
          violations.push(`${id} runs package code (${routes.join(', ')}) and holds ${credentials.join(', ')}`);
        }
        if (mintsOidc(workflow, job)) {
          const others = credentials.filter((credential) => credential !== 'id-token: write');
          if (others.length > 0) violations.push(`${id} can mint an OIDC token and also holds ${others.join(', ')}`);
          const repository = steps(job)
            .filter((step) => step.uses?.startsWith('actions/checkout@') || step.uses?.startsWith('./'))
            .map((step) => step.uses);
          if (repository.length > 0) {
            violations.push(`${id} can mint an OIDC token and runs repository content (${repository.join(', ')})`);
          }
        }
        for (const step of steps(job).filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) {
          if (step.with?.['persist-credentials'] !== false || step.with?.token !== undefined) {
            violations.push(`${id} has a checkout that persists a credential`);
          }
        }
      }
      for (const [id, job] of jobs) {
        if (steps(job).some((step) => READS_RELEASES.test(commands(step))) && !seesDraftReleases(workflow, job)) {
          violations.push(`${id} reads Releases with gh but cannot see draft Releases`);
        }
        if (releasePackageRoutes(workflow, job).length === 0) continue;
        for (const need of [job.needs ?? []].flat()) {
          const feeder = workflow.jobs[need];
          const actions = steps(feeder).filter((step) => step.uses).map((step) => step.uses);
          const credentials = credentialsOf(workflow, feeder);
          if (credentials.length > 0 && actions.length > 0) {
            violations.push(`${need} holds ${credentials.join(', ')} and feeds package code in ${id}, but runs ${actions.join(', ')}`);
          }
        }
      }
      const publishers = jobs
        .filter(([, job]) => steps(job).some((step) => commands(step).split('\n').some((line) => line.trim() === TARBALL_PUBLISH)))
        .map(([id]) => id);
      if (publishers.length !== 1 || !mintsOidc(workflow, workflow.jobs[publishers[0]])) {
        violations.push(`expected one OIDC job to publish the packed tarball, found ${publishers.join(', ') || 'none'}`);
      }
      return violations;
    };
    const runBash = (script, env) => {
      try {
        return { status: 0, stdout: execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (error) {
        if (typeof error.status !== 'number') throw error;
        return { status: error.status, stdout: error.stdout, stderr: error.stderr };
      }
    };
    const mutated = (change) => {
      const workflow = structuredClone(releaseWorkflow);
      change(workflow);
      return workflow;
    };
    const stepNamed = (job, name) => {
      const step = steps(job ?? {}).find((candidate) => candidate.name === name);
      if (!step) throw new Error(`release.yml has no step named ${name}`);
      return step;
    };
    const PUBLISH_STEP = 'Publish to npm via Trusted Publishing';
    const VALIDATE_STEP = 'Refuse build outputs that are not well-formed versions';
    const replacePublishLine = (workflow, line) => {
      const step = stepNamed(workflow.jobs.publish, PUBLISH_STEP);
      step.run = step.run.replace(TARBALL_PUBLISH, line);
    };

    test('no job that runs package code holds a credential, and only the OIDC job publishes', () => {
      expect(releaseViolations(releaseWorkflow)).toEqual([]);
      expect(Object.keys(releaseWorkflow.jobs)).toEqual(['read-releases', 'build', 'release', 'publish']);
      const { 'read-releases': readReleases, build, release, publish } = releaseWorkflow.jobs;
      expect(releasePackageRoutes(releaseWorkflow, readReleases)).toEqual([]);
      expect(readReleases.permissions).toEqual({ contents: 'write' });
      expect(releasePackageRoutes(releaseWorkflow, build).length).toBeGreaterThan(0);
      expect(credentialsOf(releaseWorkflow, build)).toEqual([]);
      expect(build.permissions).toEqual({ contents: 'read' });
      expect(releasePackageRoutes(releaseWorkflow, release)).toEqual([]);
      expect(release.permissions).toEqual({ contents: 'write' });
      expect(releasePackageRoutes(releaseWorkflow, publish)).toEqual([]);
      expect(publish.permissions).toEqual({ 'id-token': 'write' });
      expect(releaseWorkflow.permissions).toEqual({ contents: 'read' });
    });

    test('the build job checks the package surface with the exact npm the publish job publishes with', () => {
      const npmInstalls = (job) =>
        steps(job).flatMap((step) =>
          commands(step)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('npm install -g npm@')),
        );
      const published = npmInstalls(releaseWorkflow.jobs.publish);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatch(/^npm install -g npm@\d+\.\d+\.\d+$/);
      expect(npmInstalls(releaseWorkflow.jobs.build)).toEqual(published);
    });

    test.each([
      ['an install in the publish job', (w) => w.jobs.publish.steps.push({ name: 'Install', run: 'pnpm install --frozen-lockfile' }), 'publish runs package code'],
      ['changeset publish in the publish job', (w) => replacePublishLine(w, 'pnpm exec changeset publish --tag "$TAG"'), 'publish runs package code'],
      ['a pnpm setup action in the publish job', (w) => w.jobs.publish.steps.unshift({ uses: tagCompatiblePnpmSetup }), 'publish runs package code'],
      ['publishing a workspace folder', (w) => replacePublishLine(w, 'npm publish packages/cli --access public --tag "$TAG"'), 'publish runs package code'],
      ['a checkout in the publish job', (w) => w.jobs.publish.steps.unshift({ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false } }), 'publish can mint an OIDC token and runs repository content'],
      ['a local action in the publish job', (w) => w.jobs.publish.steps.push({ uses: './.github/composite-actions/share-contract-reader-gate' }), 'publish can mint an OIDC token and runs repository content'],
      ['id-token on the build job', (w) => { w.jobs.build.permissions = { contents: 'read', 'id-token': 'write' }; }, 'build runs package code'],
      ['a write token on the build job', (w) => { w.jobs.build.permissions = { contents: 'write' }; }, 'build runs package code'],
      ['a secret in the build job', (w) => { stepNamed(w.jobs.build, 'Install').env = { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }; }, 'build runs package code'],
      ['a build job that inherits write permissions', (w) => { delete w.jobs.build.permissions; w.permissions = { contents: 'write', 'id-token': 'write' }; }, 'build runs package code'],
      ['id-token on the release job', (w) => { w.jobs.release.permissions = { contents: 'write', 'id-token': 'write' }; }, 'release can mint an OIDC token and also holds contents: write'],
      ['a checkout that persists its token', (w) => { delete w.jobs.release.steps[0].with['persist-credentials']; }, 'release has a checkout that persists a credential'],
      ['a publish job that publishes nothing', (w) => replacePublishLine(w, 'true'), 'expected one OIDC job to publish the packed tarball, found none'],
      ['a gh release read in the build job', (w) => w.jobs.build.steps.push({ name: 'Peek', run: 'gh release list --repo "$GITHUB_REPOSITORY"' }), 'build reads Releases with gh but cannot see draft Releases'],
      ['read-releases narrowed so drafts are invisible', (w) => { w.jobs['read-releases'].permissions = { contents: 'read' }; }, 'read-releases reads Releases with gh but cannot see draft Releases'],
      ['a checkout in read-releases', (w) => w.jobs['read-releases'].steps.unshift({ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false } }), 'read-releases holds contents: write and feeds package code in build, but runs actions/checkout@'],
      ['an install in read-releases', (w) => w.jobs['read-releases'].steps.push({ name: 'Install', run: 'pnpm install --frozen-lockfile' }), 'read-releases runs package code'],
    ])('the shape check bites on %s', (_, change, expected) => {
      const introduced = expect.arrayContaining([expect.stringContaining(expected)]);
      expect(releaseViolations(releaseWorkflow)).not.toEqual(introduced);
      expect(releaseViolations(mutated(change))).toEqual(introduced);
    });

    test('the build job packs the overridden cli after its prepublishOnly, and the publish job reads that artifact', () => {
      const { build, publish } = releaseWorkflow.jobs;
      const index = (name) => steps(build).indexOf(stepNamed(build, name));
      const prepublish = stepNamed(build, "Run the cli's prepublishOnly against the overridden versions");
      const pack = stepNamed(build, 'Pack the cli tarball');
      const upload = stepNamed(build, 'Upload the packed tarball for the publish job');
      expect(prepublish.run).toBe('pnpm run prepublishOnly');
      expect(commands(pack)).toContain('pnpm pack --pack-destination "$RUNNER_TEMP/npm-package"');
      for (const step of [prepublish, pack]) expect(step['working-directory']).toBe('packages/cli');
      for (const step of [prepublish, pack, upload]) expect(step.if).toBe(PACK_IF);
      expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
      expect(upload.with).toMatchObject({ name: 'npm-package', path: '${{ runner.temp }}/npm-package/*.tgz', 'if-no-files-found': 'error' });
      expect(index('Override fixed-group versions to X.Y.Z-beta.N')).toBeLessThan(index(prepublish.name));
      expect(index('Validate stable_version + override package.json (publish-stable)')).toBeLessThan(index(prepublish.name));
      expect(index(prepublish.name)).toBeLessThan(index(pack.name));
      expect(index(pack.name)).toBeLessThan(index(upload.name));
      const download = steps(publish).find((step) => step.uses?.startsWith('actions/download-artifact@'));
      expect(download.with).toEqual({ name: 'npm-package', path: '${{ runner.temp }}/npm-package' });
      expect(stepNamed(publish, PUBLISH_STEP).env.PACKAGE_DIR).toBe('${{ runner.temp }}/npm-package');
      expect(publish.needs).toEqual(['build', 'release']);
      expect(releaseWorkflow.jobs.release.needs).toBe('build');
      for (const job of ['release', 'publish']) expect(releaseWorkflow.jobs[job].if).toBe(RUN_IF);
    });

    test('the credential jobs take from the build job only what needs package code to compute', () => {
      const reads = (id) => {
        const job = releaseWorkflow.jobs[id];
        return expressions(job)
          .filter(({ expr }) => /\bneeds\b/.test(expr))
          .map(({ path, expr }) =>
            `${(path[0] === 'steps' ? ['steps', job.steps[path[1]].name, ...path.slice(2)] : path).join(' > ')}: ${expr}`,
          );
      };
      const RESOLVE = 'Resolve -beta.N counter';
      expect(reads('release')).toEqual([
        `if: ${RUN_IF}`,
        `steps > ${VALIDATE_STEP} > if: ${BETA_IF}`,
        `steps > ${VALIDATE_STEP} > env > BASE_VERSION: needs.build.outputs.base_version`,
        `steps > ${VALIDATE_STEP} > env > BUILD_VERSION: needs.build.outputs.version`,
        `steps > Guard - beta base must lead the latest stable > if: ${BETA_IF}`,
        'steps > Guard - beta base must lead the latest stable > env > BASE_VERSION: needs.build.outputs.base_version',
        `steps > ${RESOLVE} > if: ${BETA_IF}`,
        `steps > ${RESOLVE} > env > BASE_VERSION: needs.build.outputs.base_version`,
        `steps > Refuse a beta the build job resolved differently > if: ${BETA_IF}`,
        'steps > Refuse a beta the build job resolved differently > env > BUILD_VERSION: needs.build.outputs.version',
        `steps > Attest production reader before release > if: ${RUN_IF}`,
        `steps > Tag + create prerelease GitHub Release > if: ${BETA_IF}`,
        'steps > Tag + create prerelease GitHub Release > env > NOTES_B64: needs.build.outputs.notes_b64',
        `steps > Trigger desktop-release.yml to build + upload the desktop installers > if: ${BETA_IF}`,
      ]);
      expect(reads('publish')).toEqual([
        `if: ${RUN_IF}`,
        `steps > ${PUBLISH_STEP} > env > BETA_VERSION: needs.release.outputs.version`,
      ]);
      const { build, release } = releaseWorkflow.jobs;
      const algorithm = (step) => commands(step).slice(commands(step).indexOf('MAX_N=-1'));
      expect(algorithm(stepNamed(release, RESOLVE)).length).toBeGreaterThan(0);
      expect(algorithm(stepNamed(release, RESOLVE))).toBe(algorithm(stepNamed(build, RESOLVE)));
      expect(commands(stepNamed(release, RESOLVE))).not.toContain('::error::');
      expect(stepNamed(release, 'Checkout').with.ref).toBe('${{ github.sha }}');
      for (const name of ['Tag + create prerelease GitHub Release', 'Trigger desktop-release.yml to build + upload the desktop installers']) {
        expect(stepNamed(release, name).env.TAG).toBe('${{ steps.resolve-beta.outputs.tag }}');
      }
      expect(release.outputs).toEqual({ version: '${{ steps.resolve-beta.outputs.version }}' });
    });

    test("the release job checks the build job's versions before any step prints them", () => {
      const { release } = releaseWorkflow.jobs;
      const validate = stepNamed(release, VALIDATE_STEP);
      expect(validate.if).toBe(BETA_IF);
      const readers = steps(release).filter(
        (step) => step !== validate && /needs\.build\.outputs\.(base_version|version)\b/.test(JSON.stringify(step.env ?? {})),
      );
      expect(readers.map((step) => step.name)).toEqual([
        'Guard - beta base must lead the latest stable',
        'Resolve -beta.N counter',
        'Refuse a beta the build job resolved differently',
      ]);
      for (const step of readers) expect(steps(release).indexOf(validate), step.name).toBeLessThan(steps(release).indexOf(step));
      const run = (base, version) => runBash(validate.run, { PATH: process.env.PATH, BASE_VERSION: base, BUILD_VERSION: version });
      expect(run('0.82.0', '0.82.0-beta.9').status).toBe(0);
      for (const [base, version] of [
        ['0.82.0\n::warning::injected', '0.82.0-beta.9'],
        ['0.82.0', '0.82.0-beta.9\n::warning::injected'],
        ['', '0.82.0-beta.9'],
        ['0.82.0', '0.82.0'],
      ]) {
        const refused = run(base, version);
        expect(refused.status, JSON.stringify([base, version])).toBe(1);
        expect(refused.stdout).not.toContain('injected');
        expect(refused.stdout).toMatch(/^::error::The build job's (base_version|version) is not/m);
      }
    });

    describe('the release job pushes its tag with the job token through a one-command credential helper', () => {
      const TAG_STEP = 'Tag + create prerelease GitHub Release';
      const TAG = 'v0.82.0-beta.9';
      const TOKEN = 'placeholder-job-token';
      const root = mkdtempSync(join(tmpdir(), 'release-tag-push-'));
      afterAll(() => rmSync(root, { recursive: true, force: true }));
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const recorder = (exitWhen) =>
        [
          '#!/usr/bin/env node',
          "const { appendFileSync } = require('node:fs');",
          'const args = process.argv.slice(2);',
          "appendFileSync(process.env.CALL_LOG, `${JSON.stringify([require('node:path').basename(process.argv[1]), ...args])}\\n`);",
          `process.exit(${exitWhen} ? 1 : 0);`,
          '',
        ].join('\n');
      writeFileSync(join(bin, 'git'), recorder('false'), { mode: 0o755 });
      writeFileSync(join(bin, 'gh'), recorder("args[0] === 'release' && args[1] === 'view'"), { mode: 0o755 });
      let runs = 0;
      const tagStepRun = (workflow) => {
        runs += 1;
        const step = stepNamed(workflow.jobs.release, TAG_STEP);
        const log = join(root, `calls-${runs}.log`);
        const env = { PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, TMPDIR: root };
        const known = { GH_TOKEN: TOKEN, TAG, NOTES_B64: Buffer.from('Notes.\n').toString('base64') };
        for (const name of Object.keys(step.env ?? {})) env[name] = known[name];
        const result = runBash(step.run, env);
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        return { result, calls, stepEnv: step.env ?? {} };
      };
      const credentialFill = (configured, env) =>
        execFileSync('git', [...configured, 'credential', 'fill'], {
          input: 'protocol=https\nhost=github.com\n\n',
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...env },
        });

      test('the push resets every configured helper and installs the App-style helper, and nothing else carries a credential', async () => {
        const { APP_CREDENTIAL_HELPER } = await import('./point-release-plan.mjs');
        const { result, calls } = tagStepRun(releaseWorkflow);
        expect(result.status, result.stderr).toBe(0);
        const pushes = calls.filter((call) => call[0] === 'git' && call.includes('push'));
        expect(pushes).toEqual([
          ['git', '-c', 'credential.helper=', '-c', `credential.helper=${APP_CREDENTIAL_HELPER}`, 'push', 'origin', TAG],
        ]);
      });

      test('the helper answers with the GH_TOKEN the step is given, and a helper configured beforehand is not consulted', () => {
        const { calls, stepEnv } = tagStepRun(releaseWorkflow);
        expect(stepEnv.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
        const push = calls.find((call) => call[0] === 'git' && call.includes('push'));
        const configured = push.slice(1, push.indexOf('push'));
        const env = Object.fromEntries(Object.keys(stepEnv).filter((name) => name === 'GH_TOKEN').map((name) => [name, TOKEN]));
        expect(credentialFill(configured, env)).toContain(`username=x-access-token\npassword=${TOKEN}\n`);
        const preconfigured = ['-c', 'credential.helper=!f() { echo username=someone-else; echo password=persisted-credential; }; f'];
        const filled = credentialFill([...preconfigured, ...configured], env);
        expect(filled).not.toContain('persisted-credential');
        expect(filled).toContain(`password=${TOKEN}\n`);
      });
    });

    test('the release job refuses a beta the build job resolved differently', () => {
      const refusal = stepNamed(releaseWorkflow.jobs.release, 'Refuse a beta the build job resolved differently');
      expect(refusal.env.RESOLVED).toBe('${{ steps.resolve-beta.outputs.version }}');
      const run = (resolved, built) =>
        runBash(refusal.run, { PATH: process.env.PATH, RESOLVED: resolved, BUILD_VERSION: built });
      expect(run('0.82.0-beta.9', '0.82.0-beta.9').status).toBe(0);
      const refused = run('0.82.0-beta.10', '0.82.0-beta.9');
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('::error::The build job packed 0.82.0-beta.9, but this job resolved 0.82.0-beta.10');
      expect(refused.stdout).toContain('Re-run all jobs');
    });

    describe('the publish step publishes only the expected package from the downloaded tarball', () => {
      const publishStep = () => stepNamed(releaseWorkflow.jobs.publish, PUBLISH_STEP);
      const root = mkdtempSync(join(tmpdir(), 'release-publish-step-'));
      afterAll(() => rmSync(root, { recursive: true, force: true }));
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const npmCliPath = execFileSync('npm', ['exec', '--call', 'node -p process.env.npm_execpath'], {
        cwd: tmpdir(),
        encoding: 'utf8',
      }).trim();
      const nodeGlobalRoot = dirname(dirname(dirname(npmCliPath)));
      writeFileSync(
        join(bin, 'npm'),
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NPM_LOG"\nif [ "$1" = root ]; then printf \'%s\\n\' "$NPM_GLOBAL_ROOT"; exit 0; fi\nif [ "$1" = view ]; then [ -n "$NPM_VIEW" ] || exit 1; printf \'%s\\n\' "$NPM_VIEW"; fi\nexit 0\n',
        { mode: 0o755 },
      );
      const { gzipSync } = createRequire(import.meta.url)('node:zlib');
      const ZERO_BLOCK = Buffer.alloc(512);
      const tarEntry = (name, content) => {
        const body = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
        const header = Buffer.alloc(512);
        const put = (text, offset, length) => header.write(text, offset, length, 'ascii');
        put(name, 0, 100);
        put('0000644\0', 100, 8);
        put('0000000\0', 108, 8);
        put('0000000\0', 116, 8);
        put(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
        put('00000000000\0', 136, 12);
        put('        ', 148, 8);
        put('0', 156, 1);
        put('ustar\0', 257, 6);
        put('00', 263, 2);
        put(`${header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
        return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
      };
      const tgz = (...blocks) => gzipSync(Buffer.concat([...blocks, ZERO_BLOCK, ZERO_BLOCK]));
      let cases = 0;
      const publishWith = ({ tarballs, action = '', beta = '0.82.0-beta.9', stable = '', view = '', globalRoot = nodeGlobalRoot }) => {
        cases += 1;
        const dir = join(root, `case-${cases}`);
        const packageDir = join(dir, 'npm-package');
        mkdirSync(packageDir, { recursive: true });
        for (const [index, tarball] of tarballs.entries()) {
          if (Buffer.isBuffer(tarball)) {
            writeFileSync(join(packageDir, `package-${index}.tgz`), tarball);
            continue;
          }
          const source = join(dir, `source-${index}`);
          const { files, members } = tarball.files ? tarball : { files: { 'package/package.json': tarball }, members: ['package'] };
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(source, path)), { recursive: true });
            writeFileSync(join(source, path), typeof content === 'string' ? content : JSON.stringify(content));
          }
          execFileSync('tar', ['-czf', join(packageDir, `package-${index}.tgz`), '-C', source, ...members]);
        }
        const log = join(dir, 'npm.log');
        const step = publishStep();
        const result = runBash(step.run, {
          PATH: `${bin}:${process.env.PATH}`,
          ACTION: action,
          BETA_VERSION: beta,
          STABLE_VERSION: stable,
          PACKAGE_NAME: step.env.PACKAGE_NAME,
          PACKAGE_DIR: packageDir,
          NPM_LOG: log,
          NPM_VIEW: view,
          NPM_GLOBAL_ROOT: globalRoot,
          HTTPS_PROXY: 'http://127.0.0.1:9',
          HTTP_PROXY: 'http://127.0.0.1:9',
          https_proxy: 'http://127.0.0.1:9',
          http_proxy: 'http://127.0.0.1:9',
          NO_PROXY: '',
        });
        const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
        return { ...result, calls, publishes: calls.filter((call) => call.startsWith('publish ')), packageDir };
      };
      const cli = (version, extra = {}) => ({ name: '@inkeep/open-knowledge', version, publishConfig: { access: 'public' }, ...extra });

      test('the stub npm hands the step a real pacote, the one bundled with the npm on PATH', () => {
        expect(existsSync(join(nodeGlobalRoot, 'npm', 'node_modules', 'pacote', 'package.json'))).toBe(true);
        expect(commands(publishStep())).toContain('pacote="$(npm root -g)/npm/node_modules/pacote"');
        expect(commands(publishStep())).not.toMatch(/\btar\s/);
      });

      test('a pacote that does not load from the computed path is named by that path, and the tarball is not blamed', () => {
        const globalRoot = join(root, 'no-pacote');
        mkdirSync(globalRoot);
        const pacote = join(globalRoot, 'npm', 'node_modules', 'pacote');
        const result = publishWith({ tarballs: [cli('0.82.0-beta.9')], globalRoot });
        expect(result.status).toBe(1);
        expect(result.publishes).toEqual([]);
        const lines = `${result.stdout}\n${result.stderr}`.split('\n');
        expect(lines.filter((line) => line.startsWith('::error::'))).toEqual([expect.stringContaining(pacote)]);
        expect(lines.filter((line) => line.includes('packed tarball'))).toEqual([]);
        expect(result.stderr).toContain(`"Cannot find module '${pacote}'`);
      });

      test('a tarball pacote loads but cannot read gets the tarball message, not the pacote one', () => {
        const result = publishWith({ tarballs: [Buffer.from('not a gzip tarball\n')] });
        expect(result.status).toBe(1);
        expect(result.publishes).toEqual([]);
        const lines = `${result.stdout}\n${result.stderr}`.split('\n');
        expect(lines.filter((line) => line.startsWith('::error::'))).toEqual([
          "::error::npm cannot read the packed tarball's manifest; its reason is printed above, JSON-encoded. Refusing to publish.",
        ]);
        const reasons = result.stderr.split('\n').filter((line) => {
          try {
            return typeof JSON.parse(line) === 'string';
          } catch {
            return false;
          }
        });
        expect(reasons).toHaveLength(1);
      });

      test('the step passes provenance and the registry as CLI flags, which publishConfig cannot override, and names the package it checks', () => {
        expect(commands(publishStep()).split('\n').map((line) => line.trim()).filter((line) => /\bnpm\s+publish\b/.test(line))).toEqual([TARBALL_PUBLISH]);
        expect(publishStep().env).not.toHaveProperty('NPM_CONFIG_PROVENANCE');
        expect(publishStep().env.PACKAGE_NAME).toBe('@inkeep/open-knowledge');
      });

      test('a well-formed tarball built byte by byte publishes, so the zero-block row is refused for its hidden manifest alone', () => {
        const result = publishWith({ tarballs: [tgz(tarEntry('package/package.json', cli('0.82.0-beta.9')), tarEntry('package/index.js', 'module.exports = 1;\n'))] });
        expect(result.status, result.stderr).toBe(0);
        expect(result.publishes).toHaveLength(1);
      });

      test('a beta publishes the downloaded tarball under the beta tag', () => {
        const result = publishWith({ tarballs: [cli('0.82.0-beta.9')] });
        expect(result.status, result.stderr).toBe(0);
        expect(result.publishes).toEqual([
          `publish ${join(result.packageDir, 'package-0.tgz')} --access public --tag beta --provenance --registry https://registry.npmjs.org/`,
        ]);
      });

      test('a stable publishes the dispatched version under the latest tag', () => {
        const result = publishWith({ tarballs: [cli('0.82.0')], action: 'publish-stable', beta: '', stable: '0.82.0' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.publishes).toEqual([
          `publish ${join(result.packageDir, 'package-0.tgz')} --access public --tag latest --provenance --registry https://registry.npmjs.org/`,
        ]);
      });

      test.each([
        ['a v-prefixed version', cli('v0.82.0-beta.9')],
        ['build metadata on the version', cli('0.82.0-beta.9+build.1')],
        ['a padded name', { ...cli('0.82.0-beta.9'), name: ' @inkeep/open-knowledge ' }],
      ])('the step checks %s as the cleaned manifest npm publishes, not the raw bytes', (_, manifest) => {
        const result = publishWith({ tarballs: [manifest] });
        expect(result.status, result.stdout).toBe(0);
        expect(result.publishes).toHaveLength(1);
      });

      test('a version already on npm is skipped, as changeset publish skipped it', () => {
        const result = publishWith({ tarballs: [cli('0.82.0-beta.9')], view: '0.82.0-beta.9' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('::notice::@inkeep/open-knowledge@0.82.0-beta.9 is already on npm');
        expect(result.publishes).toEqual([]);
      });

      test.each([
        ['a different version', { tarballs: [cli('0.82.0-beta.8')] }, '"version":"0.82.0-beta.8"'],
        ['a different package', { tarballs: [{ ...cli('0.82.0-beta.9'), name: '@inkeep/open-knowledge-core' }] }, '"name":"@inkeep/open-knowledge-core"'],
        ['a publishConfig that redirects the registry', { tarballs: [cli('0.82.0-beta.9', { publishConfig: { access: 'public', '@inkeep:registry': 'https://registry.example.test/' } })] }, 'whose publishConfig may set access and nothing else'],
        ['a publishConfig that turns provenance off', { tarballs: [cli('0.82.0-beta.9', { publishConfig: { access: 'public', provenance: false } })] }, 'whose publishConfig may set access and nothing else'],
        [
          'a second manifest that npm would read instead',
          { tarballs: [{ files: { 'package/package.json': cli('0.82.0-beta.9'), 'x/package.json': cli('0.82.0-beta.9', { publishConfig: { provenance: false } }) }, members: ['package', 'x'] }] },
          '"publishConfig":{"provenance":false}',
        ],
        [
          'a later package/package.json that differs',
          {
            tarballs: [
              tgz(
                tarEntry('package/package.json', cli('0.82.0-beta.9')),
                tarEntry('package/package.json', cli('9.9.9', { publishConfig: { access: 'public', tag: 'latest' } })),
              ),
            ],
          },
          '"version":"9.9.9"',
        ],
        [
          'a second package/package.json hidden behind one zero block',
          {
            tarballs: [
              tgz(
                tarEntry('package/package.json', cli('0.82.0-beta.9')),
                tarEntry('package/index.js', 'module.exports = 1;\n'),
                ZERO_BLOCK,
                tarEntry('package/package.json', cli('9.9.9', { publishConfig: { access: 'public', tag: 'latest' } })),
              ),
            ],
          },
          '"version":"9.9.9"',
        ],
        ['two tarballs', { tarballs: [cli('0.82.0-beta.9'), cli('0.82.0-beta.9')] }, 'holds 2 tarballs, not one'],
        ['no tarball', { tarballs: [] }, 'holds 0 tarballs, not one'],
      ])('the step refuses %s', (_, input, message) => {
        const result = publishWith(input);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(message);
        expect(result.publishes).toEqual([]);
      });

      test.each([
        ['name', { ...cli('0.82.0-beta.9'), name: 'evil\n::warning::injected' }],
        ['version', cli('0.82.0-beta.9\n::warning::injected')],
        ['publishConfig', cli('0.82.0-beta.9', { publishConfig: { access: 'public', 'x\n::warning::injected': true } })],
      ])('a manifest %s carrying a newline cannot start a workflow command in the refusal', (_, manifest) => {
        const result = publishWith({ tarballs: [manifest] });
        expect(result.status).toBe(1);
        expect(result.publishes).toEqual([]);
        const lines = `${result.stdout}\n${result.stderr}`.split('\n');
        expect(lines.filter((line) => line.startsWith('::warning::'))).toEqual([]);
        expect(lines.some((line) => line.startsWith('::error::'))).toBe(true);
      });
    });

    describe('read-releases hands build the previous beta that a contents: write read sees, drafts included', () => {
      const READ_STEP = 'Read the newest beta Release, drafts included, and its body';
      const COMPUTE_STEP = 'Compute next beta base version + render release notes';
      const BETA_PATH = "github.event_name == 'push' || github.event_name == 'workflow_dispatch'";

      test('read-releases always runs, runs only gh release list and view, and build takes its outputs under their own names', () => {
        const { 'read-releases': readReleases, build } = releaseWorkflow.jobs;
        expect(readReleases.if).toBeUndefined();
        expect(readReleases.needs).toBeUndefined();
        expect(steps(readReleases).map((step) => step.name)).toEqual([READ_STEP]);
        const read = stepNamed(readReleases, READ_STEP);
        expect(read.uses).toBeUndefined();
        expect(read.if).toBe(BETA_PATH);
        expect(read.if).toBe(stepNamed(build, COMPUTE_STEP).if);
        expect(read.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
        expect(commands(read).match(/\bgh\s+\S+\s+\S+/g)).toEqual(['gh release list', 'gh release view']);
        expect(build.needs).toBe('read-releases');
        const names = Object.keys(readReleases.outputs);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          expect(readReleases.outputs[name]).toBe(`\${{ steps.read.outputs.${name} }}`);
          expect(commands(read)).toContain(`record ${name} `);
        }
        const reads = expressions(build)
          .filter(({ expr }) => /\bneeds\b/.test(expr))
          .map(({ path, expr }) => `${(path[0] === 'steps' ? ['steps', build.steps[path[1]].name, ...path.slice(2)] : path).join(' > ')}: ${expr}`);
        expect(reads).toEqual(
          names.map((name) => `steps > ${COMPUTE_STEP} > env > ${name.toUpperCase()}: needs.read-releases.outputs.${name}`),
        );
      });

      const root = mkdtempSync(join(tmpdir(), 'release-read-releases-'));
      afterAll(() => rmSync(root, { recursive: true, force: true }));
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const stub = join(bin, 'gh');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env node',
          "const { appendFileSync } = require('node:fs');",
          'const args = process.argv.slice(2);',
          "appendFileSync(process.env.STUB_LOG, `${JSON.stringify(args)}\\n`);",
          'const world = JSON.parse(process.env.STUB_WORLD);',
          'const failure = (world.fail ?? {})[args[1]];',
          "if (failure) { process.stderr.write(failure.stderr ?? ''); process.exit(failure.status); }",
          "const visible = world.releases.filter((release) => world.token === 'write' || !release.isDraft);",
          "if (args[1] === 'list') {",
          '  const first = visible.find((release) => release.isPrerelease && /^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$/.test(release.tagName));',
          "  process.stdout.write(`${first ? first.tagName : ''}\\n`);",
          '  process.exit(0);',
          '}',
          'const release = visible.find((candidate) => candidate.tagName === args[2]);',
          "if (!release) { process.stderr.write('release not found\\n'); process.exit(1); }",
          'process.stdout.write(`${release.body}\\n`);',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      let runs = 0;
      const parseOutputs = (text) => {
        const out = {};
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
          if (heredoc) {
            const end = lines.indexOf(heredoc[2], i + 1);
            out[heredoc[1]] = lines.slice(i + 1, end).join('\n');
            i = end;
          } else if (lines[i].includes('=')) {
            out[lines[i].slice(0, lines[i].indexOf('='))] = lines[i].slice(lines[i].indexOf('=') + 1);
          }
        }
        return out;
      };
      const throughTheWorkflow = (workflow, world, repo) => {
        runs += 1;
        const dir = join(root, `run-${runs}`);
        mkdirSync(dir);
        const outputFile = join(dir, 'github-output');
        writeFileSync(outputFile, '');
        const log = join(dir, 'gh-calls.log');
        const read = stepNamed(workflow.jobs['read-releases'], READ_STEP);
        const result = runBash(read.run, {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: outputFile,
          GITHUB_REPOSITORY: repo,
          GH_TOKEN: 'stub',
          STUB_LOG: log,
          STUB_WORLD: JSON.stringify({ ...world, token: 'write' }),
        });
        expect(result.status, result.stderr).toBe(0);
        const stepOutputs = parseOutputs(readFileSync(outputFile, 'utf8'));
        const jobOutputs = Object.fromEntries(
          Object.entries(workflow.jobs['read-releases'].outputs).map(([name, expression]) => [
            name,
            stepOutputs[/^\$\{\{ steps\.read\.outputs\.([\w-]+) \}\}$/.exec(expression)?.[1]] ?? '',
          ]),
        );
        const env = Object.fromEntries(
          Object.entries(stepNamed(workflow.jobs.build, COMPUTE_STEP).env ?? {}).flatMap(([name, expression]) => {
            const output = /^\$\{\{ needs\.read-releases\.outputs\.([\w-]+) \}\}$/.exec(expression)?.[1];
            return output ? [[name, jobOutputs[output] ?? '']] : [];
          }),
        );
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        return { env, calls };
      };
      const directly = (world, token) => (args) => {
        try {
          return {
            status: 0,
            stdout: execFileSync(stub, args, {
              encoding: 'utf8',
              env: { PATH: process.env.PATH, STUB_LOG: join(root, 'direct.log'), STUB_WORLD: JSON.stringify({ ...world, token }) },
              stdio: ['ignore', 'pipe', 'pipe'],
            }),
            stderr: '',
          };
        } catch (error) {
          if (typeof error.status !== 'number') throw error;
          return { status: error.status, stdout: error.stdout, stderr: error.stderr };
        }
      };
      const marker = (ids) => `Notes for the beta.\n\n<!-- ok-consumed-set: ${JSON.stringify(ids)} -->\n\n`;
      const beta = (tagName, body, isDraft = false) => ({ tagName, isDraft, isPrerelease: true, body });
      const draftNewest = {
        releases: [
          beta('v0.82.0-beta.9', marker(['a', 'b']), true),
          beta('v0.82.0-beta.8', marker(['a'])),
          { tagName: 'v0.81.4', isDraft: false, isPrerelease: false, body: 'Stable.' },
        ],
      };
      const worlds = {
        'the previous beta is still a draft': draftNewest,
        'the list fails': { releases: draftNewest.releases, fail: { list: { status: 1, stderr: 'HTTP 502: Bad Gateway\n' } } },
        'there is no beta Release': { releases: [{ tagName: 'v0.81.4', isDraft: false, isPrerelease: false, body: 'Stable.' }] },
        'the view fails': { releases: draftNewest.releases, fail: { view: { status: 1, stderr: 'HTTP 404\n' } } },
        'the body has no marker': { releases: [beta('v0.82.0-beta.9', 'Notes without a marker.\n')] },
        'the marker is not JSON': { releases: [beta('v0.82.0-beta.9', 'Notes.\n<!-- ok-consumed-set: [a, b] -->')] },
        'the marker is not a string array': { releases: [beta('v0.82.0-beta.9', 'Notes.\n<!-- ok-consumed-set: [1, 2] -->')] },
      };

      test.each(Object.keys(worlds))('when %s, build replays exactly what a contents: write gh read returns', async (name) => {
        const { previousBeta, recordedReleases, RELEASE_LIST_ARGS, releaseViewArgs } = await import('../../scripts/compute-next-beta.mjs');
        const world = worlds[name];
        const { env, calls } = throughTheWorkflow(releaseWorkflow, world, RELEASE_LIST_ARGS[3]);
        const replayed = previousBeta(recordedReleases(env));
        expect(replayed).toEqual(previousBeta(directly(world, 'write')));
        expect(calls).toEqual(replayed.prevBetaTag ? [RELEASE_LIST_ARGS, releaseViewArgs(replayed.prevBetaTag)] : [RELEASE_LIST_ARGS]);
      });

      test('with the previous beta still a draft, the replay is the draft and not what a contents: read token sees', async () => {
        const { previousBeta, recordedReleases, RELEASE_LIST_ARGS } = await import('../../scripts/compute-next-beta.mjs');
        const { env } = throughTheWorkflow(releaseWorkflow, draftNewest, RELEASE_LIST_ARGS[3]);
        expect(previousBeta(recordedReleases(env))).toEqual({ prevBetaTag: 'v0.82.0-beta.9', recovered: ['a', 'b'] });
        expect(previousBeta(directly(draftNewest, 'read'))).toEqual({ prevBetaTag: 'v0.82.0-beta.8', recovered: ['a'] });
      });
    });

    test('the build job packs the only public workspace package and runs the only publish-time script it declares', () => {
      const patterns = parse(readFileSync(join(OK_ROOT, 'pnpm-workspace.yaml'), 'utf8')).packages;
      const dirs = patterns.flatMap((pattern) => {
        if (pattern.endsWith('/*') && !/[*?{}[\]!]/.test(pattern.slice(0, -2))) {
          const parent = pattern.slice(0, -2);
          return readdirSync(join(OK_ROOT, parent), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`);
        }
        if (/[*?{}[\]!]/.test(pattern)) throw new Error(`workspace pattern ${pattern} needs a matcher this test does not have`);
        return [pattern];
      });
      const manifests = dirs
        .filter((dir) => existsSync(join(OK_ROOT, dir, 'package.json')))
        .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(OK_ROOT, dir, 'package.json'), 'utf8')) }));
      expect(manifests.filter(({ manifest }) => !manifest.private).map(({ dir, manifest }) => `${dir} ${manifest.name}`)).toEqual([
        'packages/cli @inkeep/open-knowledge',
      ]);
      const cli = manifests.find(({ dir }) => dir === 'packages/cli').manifest;
      expect(Object.keys(cli.scripts).filter((name) => ['prepublishOnly', 'prepublish', 'publish', 'postpublish'].includes(name))).toEqual([
        'prepublishOnly',
      ]);
      const { build } = releaseWorkflow.jobs;
      for (const name of ["Run the cli's prepublishOnly against the overridden versions", 'Pack the cli tarball']) {
        expect(stepNamed(build, name)['working-directory'], name).toBe('packages/cli');
      }
    });
  });
});

describe('Linux packaging ships the native prebuilds and checks them before upload', () => {
  const NATIVE_GUARD =
    'pnpm exec vitest run tests/unit/linux-package-native-guards.test.ts tests/unit/linux-package-terminal-spawn.test.ts';
  const linuxJobs = [
    ['desktop-release.yml', parse(desktopRelease).jobs['build-linux']],
    ['desktop-build-win-linux.yml', parse(desktopBuildWinLinux).jobs['build-linux']],
  ];
  const uploads = (step) =>
    step.uses?.startsWith('actions/upload-artifact@') ||
    /\bgh\s+release\s+(upload|create|edit)\b/.test(step.run ?? '');

  test.each(linuxJobs)('%s installs without forcing an Electron-ABI rebuild', (_name, job) => {
    const install = job.steps.find((step) => step.name === 'Install dependencies');
    expect(install.env).toEqual({ ELECTRON_SKIP_REBUILD: '1' });
  });

  test.each(linuxJobs)(
    '%s runs the native guard after packaging and before every upload, unskippably',
    (name, job) => {
      const packaged = job.steps.findIndex((step) => step.name?.startsWith('Package '));
      const guarded = job.steps.findIndex((step) => step.run?.trim() === NATIVE_GUARD);
      expect(packaged, `${name} build-linux has no "Package" step`).toBeGreaterThan(-1);
      expect(guarded, `${name} build-linux runs no native guard after packaging`).toBeGreaterThan(
        packaged,
      );
      const uploadSteps = job.steps.flatMap((step, index) =>
        uploads(step) ? [[index, step.name ?? step.uses]] : [],
      );
      expect(uploadSteps.length, `${name} build-linux uploads nothing`).toBeGreaterThan(0);
      for (const [index, label] of uploadSteps) {
        expect(index, `step "${label}" uploads before the native guard`).toBeGreaterThan(guarded);
      }
      const guard = job.steps[guarded];
      expect(guard['working-directory']).toBe('packages/desktop');
      expect(guard.env).toEqual({
        OK_LINUX_PACKAGE_DIR: 'dist-desktop/${{ matrix.unpacked_dir }}',
      });
      expect(guard).not.toHaveProperty('if');
      expect(guard).not.toHaveProperty('continue-on-error');
    },
  );

  test.each(linuxJobs)(
    '%s installs the runtime dependencies the built deb declares before the native guard, unskippably',
    (name, job) => {
      const packaged = job.steps.findIndex((step) => step.name?.startsWith('Package '));
      const guarded = job.steps.findIndex((step) => step.run?.trim() === NATIVE_GUARD);
      const provisioned = job.steps.findIndex((step) =>
        /\bdpkg-deb\s+--field\s+\S+\s+Depends\b/.test(step.run ?? ''),
      );
      expect(packaged, `${name} build-linux has no "Package" step`).toBeGreaterThan(-1);
      expect(
        provisioned,
        `${name} build-linux reads no built deb's Depends after packaging`,
      ).toBeGreaterThan(packaged);
      expect(provisioned, `${name} build-linux provisions after the native guard`).toBeLessThan(
        guarded,
      );
      const step = job.steps[provisioned];
      const lines = step.run
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('#'));
      const operands = lines.flatMap((line) =>
        (/\bapt-get\s+satisfy\b(.*)$/.exec(line)?.[1] ?? '')
          .split(/\s+/)
          .filter((token) => token && !token.startsWith('-')),
      );
      expect(
        operands.length,
        `${name} provisioning does not install with apt-get satisfy`,
      ).toBeGreaterThan(0);
      for (const operand of operands) {
        const variable = /^"?\$\{?(\w+)/.exec(operand)?.[1];
        expect(variable, `${name} satisfies "${operand}", not a variable`).toBeDefined();
        const fromDeb = new RegExp(
          `^${variable}\\+=\\("\\$\\(dpkg-deb\\s+--field\\s+\\S+\\s+Depends\\)"\\)$`,
        );
        const empty = new RegExp(`^(?:declare\\s+-a\\s+)?${variable}=\\(\\)$`);
        const written = new RegExp(`(?<![\\w$#!{])${variable}\\b`);
        const writes = lines.filter((line) => written.test(line));
        expect(
          writes.some((line) => fromDeb.test(line)),
          `${name} never fills ${variable} from the built deb's Depends`,
        ).toBe(true);
        expect(
          writes.filter((line) => !fromDeb.test(line) && !empty.test(line)),
          `${name} fills ${variable} from something other than the built deb's Depends`,
        ).toEqual([]);
      }
      expect(step.run).not.toMatch(/\bapt-get\s+install\b/);
      expect(step['working-directory']).toBe('packages/desktop');
      expect(step).not.toHaveProperty('if');
      expect(step).not.toHaveProperty('continue-on-error');
    },
  );

  test('every test file the native guard names exists in the desktop package', () => {
    const desktop = join(WORKFLOWS, '..', '..', 'packages', 'desktop');
    const files = /\bvitest run (.+)$/.exec(NATIVE_GUARD)[1].split(/\s+/);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(join(desktop, file)), `${file} is missing from packages/desktop`).toBe(
        true,
      );
    }
  });
});
