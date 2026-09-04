import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  cycleOf,
  highestPublishedStable,
  isPipelineTag,
  objectAgeSeconds,
  selectStuckDrafts,
  STUCK_DRAFT_MAX_AGE_SECONDS,
} from './select-stuck-drafts.mjs';

const NOW = Date.parse('2026-09-01T18:00:00Z');
const MAX_AGE = STUCK_DRAFT_MAX_AGE_SECONDS;
const OLD = '2026-08-27T19:41:28Z';
const FRESH = '2026-09-01T17:30:00Z';
const AT_GATE = new Date(NOW - MAX_AGE * 1000).toISOString();
const PAST_GATE = new Date(NOW - (MAX_AGE + 1) * 1000).toISOString();

const stableDraft = (tagName, updatedAt = OLD) => ({
  tagName,
  isDraft: true,
  isPrerelease: false,
  updatedAt,
});
const betaDraft = (tagName, updatedAt = OLD) => ({
  tagName,
  isDraft: true,
  isPrerelease: true,
  updatedAt,
});
const publishedBeta = (tagName) => ({
  tagName,
  isDraft: false,
  isPrerelease: true,
  updatedAt: OLD,
});
const published = (tagName) => ({
  tagName,
  isDraft: false,
  isPrerelease: false,
  updatedAt: OLD,
});

const select = (releases) => selectStuckDrafts({ releases, nowMs: NOW, maxAgeSeconds: MAX_AGE });
const swept = (releases) => select(releases).sweep.map((entry) => entry.tagName);
const kept = (releases) => select(releases).keep.map((entry) => entry.tagName);

describe('cycleOf', () => {
  test('strips the v prefix and any beta suffix', () => {
    expect(cycleOf('v0.68.0-beta.4')).toBe('0.68.0');
    expect(cycleOf('v0.65.0')).toBe('0.65.0');
  });
});

describe('highestPublishedStable', () => {
  test('ignores drafts and prereleases', () => {
    const releases = [
      published('v0.68.3'),
      stableDraft('v0.99.0'),
      betaDraft('v0.99.0-beta.1'),
      publishedBeta('v0.99.0-beta.2'),
    ];
    expect(highestPublishedStable(releases)).toBe('0.68.3');
  });

  test('orders numerically, not lexically', () => {
    expect(highestPublishedStable([published('v0.9.0'), published('v0.68.3')])).toBe('0.68.3');
  });

  test('is null when nothing stable has been published', () => {
    expect(highestPublishedStable([betaDraft('v0.1.0-beta.0')])).toBeNull();
  });
});

describe('isPipelineTag', () => {
  test('admits the shapes the release pipeline creates', () => {
    expect(isPipelineTag('v0.68.3')).toBe(true);
    expect(isPipelineTag('v0.68.0-beta.4')).toBe(true);
  });

  test('refuses anything else, including a plausible hand-drafted tag', () => {
    for (const tag of ['v0.60.0-rc.1', 'nightly', 'docs-preview', 'v1.2', '']) {
      expect(isPipelineTag(tag)).toBe(false);
    }
  });
});

describe('objectAgeSeconds', () => {
  test('measures the release object, never the tagged commit', () => {
    const draft = {
      tagName: 'v0.69.0',
      isDraft: true,
      isPrerelease: false,
      updatedAt: '2026-09-01T17:59:00Z',
      createdAt: '2020-01-01T00:00:00Z',
      publishedAt: null,
    };
    expect(objectAgeSeconds(draft, NOW)).toBe(60);
  });

  test('falls back to publishedAt when no updatedAt is supplied', () => {
    expect(objectAgeSeconds({ publishedAt: '2026-09-01T17:00:00Z' }, NOW)).toBe(3600);
  });

  test('is null when the object carries no timestamp of its own', () => {
    expect(objectAgeSeconds({ createdAt: '2020-01-01T00:00:00Z' }, NOW)).toBeNull();
  });
});

describe('selectStuckDrafts', () => {
  test('sweeps a stranded STABLE draft once a later stable is published', () => {
    const releases = [published('v0.68.3'), stableDraft('v0.65.0'), stableDraft('v0.66.0')];
    expect(swept(releases)).toEqual(['v0.65.0', 'v0.66.0']);
  });

  test('still sweeps a stranded beta draft on a closed cycle', () => {
    expect(swept([published('v0.68.3'), betaDraft('v0.64.0-beta.6')])).toEqual([
      'v0.64.0-beta.6',
    ]);
  });

  test('keeps a draft whose cycle no published stable covers yet', () => {
    const releases = [published('v0.68.3'), stableDraft('v0.69.0'), betaDraft('v0.69.0-beta.1')];
    expect(swept(releases)).toEqual([]);
    expect(kept(releases)).toEqual(['v0.69.0', 'v0.69.0-beta.1']);
  });

  test('sweeps the draft of the newest published stable cycle itself', () => {
    expect(swept([published('v0.68.3'), betaDraft('v0.68.3-beta.1')])).toEqual(['v0.68.3-beta.1']);
  });

  test('spares a draft younger than the age gate, whatever its cycle', () => {
    expect(swept([published('v0.68.3'), stableDraft('v0.65.0', FRESH)])).toEqual([]);
  });

  test('a draft with only a commit-age createdAt is never swept', () => {
    const draft = {
      tagName: 'v0.65.0',
      isDraft: true,
      isPrerelease: false,
      createdAt: '2020-01-01T00:00:00Z',
      publishedAt: null,
    };
    const result = select([published('v0.68.3'), draft]);
    expect(result.sweep).toEqual([]);
    expect(result.keep).toEqual([
      { tagName: 'v0.65.0', cycle: '0.65.0', reason: 'no usable timestamp' },
    ]);
  });

  test('an unparseable timestamp is never swept and never narrated as young', () => {
    const corrupt = stableDraft('v0.65.0', 'not-a-date');
    expect(objectAgeSeconds(corrupt, NOW)).toBeNull();
    const result = select([published('v0.68.3'), corrupt]);
    expect(result.sweep).toEqual([]);
    expect(result.keep).toEqual([
      { tagName: 'v0.65.0', cycle: '0.65.0', reason: 'no usable timestamp' },
    ]);
  });

  test('a hand-drafted release the pipeline never created is kept, not swept', () => {
    const handDrafted = {
      tagName: 'v0.60.0-rc.1',
      isDraft: true,
      isPrerelease: false,
      updatedAt: OLD,
    };
    const result = select([published('v0.68.3'), handDrafted]);
    expect(result.sweep).toEqual([]);
    expect(result.keep).toEqual([
      { tagName: 'v0.60.0-rc.1', cycle: null, reason: 'unrecognized tag shape' },
    ]);
  });

  test('an unrecognized tag never reaches the published-stable ceiling either', () => {
    expect(highestPublishedStable([published('v0.68.3'), published('nightly')])).toBe('0.68.3');
  });

  test('a draft exactly at the age gate is spared; one second past it is swept', () => {
    expect(swept([published('v0.68.3'), stableDraft('v0.65.0', AT_GATE)])).toEqual([]);
    expect(swept([published('v0.68.3'), stableDraft('v0.65.0', PAST_GATE)])).toEqual(['v0.65.0']);
  });

  test('a patch-level cycle above the newest stable is kept', () => {
    expect(swept([published('v0.68.3'), stableDraft('v0.68.4')])).toEqual([]);
  });

  test('the cycle gate compares numerically, so a low single-digit cycle is swept', () => {
    expect(swept([published('v0.68.3'), stableDraft('v0.9.0')])).toEqual(['v0.9.0']);
  });

  test('every draft the sweep declines is narrated with a reason', () => {
    const releases = [
      published('v0.68.3'),
      stableDraft('v0.69.0'),
      stableDraft('v0.65.0', FRESH),
      { tagName: 'nightly', isDraft: true, isPrerelease: false, updatedAt: OLD },
    ];
    const reasons = select(releases).keep.map((entry) => entry.reason);
    expect(reasons).toHaveLength(3);
    expect(reasons.every((reason) => typeof reason === 'string' && reason.length > 0)).toBe(true);
  });

  test('never proposes a published release for deletion', () => {
    expect(swept([published('v0.68.3'), published('v0.67.2')])).toEqual([]);
  });

  test('sweeps nothing at all before the first stable is published', () => {
    const result = selectStuckDrafts({
      releases: [stableDraft('v0.1.0'), betaDraft('v0.1.0-beta.0')],
      nowMs: NOW,
      maxAgeSeconds: MAX_AGE,
    });
    expect(result).toEqual({ maxStable: null, sweep: [], keep: [] });
  });
});

describe('the module CLI contract the workflow depends on', () => {
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'select-stuck-drafts.mjs');

  const run = (releases) =>
    spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, RELEASES_JSON: JSON.stringify(releases) },
    });

  test('stdout carries only the sweep tags, one per line', () => {
    const r = run([published('v0.68.3'), stableDraft('v0.65.0'), stableDraft('v0.66.0')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('v0.65.0\nv0.66.0\n');
  });

  test('narration goes to stderr, never stdout', () => {
    const r = run([published('v0.68.3'), stableDraft('v0.65.0')]);
    expect(r.stderr).toContain('Highest published stable version');
    expect(r.stdout).not.toContain('Highest published stable version');
  });

  test('an empty sweep prints nothing on stdout and still exits 0', () => {
    const r = run([published('v0.68.3')]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('no published stable prints nothing on stdout and still exits 0', () => {
    const r = run([stableDraft('v0.1.0')]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});

describe('the janitor workflow drives this module', () => {
  const workflow = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'workflows',
      'desktop-release-draft-janitor.yml',
    ),
    'utf8',
  );

  test('the sweep step calls the module rather than filtering inline', () => {
    expect(workflow).toContain('node .github/scripts/select-stuck-drafts.mjs');
  });

  test('the release list carries the object timestamp, not the commit date', () => {
    const start = workflow.indexOf('RELEASES_JSON=$(');
    const end = workflow.indexOf('sweep=$(');
    if (start === -1 || end === -1) throw new Error('the janitor no longer lists releases then sweeps');
    const listCommand = workflow.slice(start, end);
    expect(listCommand).toContain('updatedAt: .updated_at');
    expect(listCommand).not.toContain('created_at');
    expect(listCommand).not.toContain('createdAt');
  });

  test('the release list is narrowed to what the selector actually reads', () => {
    const start = workflow.indexOf('RELEASES_JSON=$(');
    const end = workflow.indexOf('sweep=$(');
    if (start === -1 || end === -1) throw new Error('the janitor no longer lists releases then sweeps');
    expect(workflow.slice(start, end)).toContain('select(.draft or (.prerelease | not))');
  });

  test('dropping published prereleases does not change the sweep set', () => {
    const releases = [
      published('v0.68.3'),
      publishedBeta('v0.68.3-beta.4'),
      publishedBeta('v0.69.0-beta.1'),
      stableDraft('v0.68.0'),
      betaDraft('v0.68.1-beta.0'),
      stableDraft('v0.69.0'),
    ];
    const narrowed = releases.filter((r) => r.isDraft || !r.isPrerelease);
    expect(narrowed.length).toBeLessThan(releases.length);
    expect(select(releases).sweep).not.toEqual([]);
    expect(select(releases)).toEqual(select(narrowed));
  });

  test('no inline filter re-narrows the sweep to prereleases', () => {
    expect(workflow).not.toContain('select(.isDraft and .isPrerelease)');
  });

  test('the sweep annotation fires after its delete, not before', () => {
    const loopStart = workflow.indexOf('while IFS= read -r tag');
    if (loopStart === -1) throw new Error('the janitor no longer loops over the sweep set');
    const loop = workflow.slice(loopStart);
    const deleteAt = loop.indexOf('gh release delete');
    const noticeAt = loop.indexOf('::notice::Swept stuck draft');
    if (deleteAt === -1 || noticeAt === -1) {
      throw new Error('the delete loop no longer deletes and annotates');
    }
    expect(noticeAt).toBeGreaterThan(deleteAt);
  });

  test('a runaway sweep set is capped rather than deleted', () => {
    expect(workflow).toContain('MAX_SWEEP_PER_RUN');
    const capAt = workflow.indexOf('::error::Refusing to sweep');
    const loop = workflow.indexOf('while IFS= read -r tag');
    if (capAt === -1 || loop === -1) throw new Error('the janitor no longer caps the sweep set');
    expect(capAt).toBeLessThan(loop);
  });

  test('a dry run is checked before the cap, so it can preview an over-cap set', () => {
    const dryRunAt = workflow.indexOf('if [ "${DRY_RUN:-false}" = "true" ]');
    const capAt = workflow.indexOf('if [ "${count}" -gt "${MAX_SWEEP_PER_RUN}" ]');
    if (dryRunAt === -1 || capAt === -1) throw new Error('the janitor no longer branches on a dry run and a cap');
    expect(dryRunAt).toBeLessThan(capAt);
  });

  test('a dry run is available and deletes nothing', () => {
    expect(workflow).toContain('dry_run');
    const dryRunAt = workflow.indexOf('if [ "${DRY_RUN:-false}" = "true" ]');
    if (dryRunAt === -1) throw new Error('the janitor no longer branches on a dry run');
    const dryRunBlock = workflow.slice(dryRunAt);
    const exitAt = dryRunBlock.indexOf('exit 0');
    const deleteAt = dryRunBlock.indexOf('gh release delete');
    if (exitAt === -1 || deleteAt === -1) throw new Error('the dry-run branch no longer guards the delete');
    expect(exitAt).toBeLessThan(deleteAt);
  });
});
