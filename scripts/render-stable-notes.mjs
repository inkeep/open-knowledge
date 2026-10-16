#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createShippedFixCheck,
  parseReleaseListing,
} from '../.github/scripts/shipped-fix-containment.mjs';
import { FIXED_GROUP_ANCHOR, fixedGroupOf, loadChangesets, maxReleaseType } from './changeset-versions.mjs';
import {
  gitAt,
  parseVerdicts,
  recordVerdicts,
  runGit,
  serializeBumpVerdicts,
  unreleasedChangesetIds,
  withVerdicts,
} from './compute-stable-version.mjs';

export const NOTES_SOURCE_MARKER = '<!-- ok-notes-source: stable-tag-tree -->';

export const EMPTY_NOTES = 'No changelog entries.';

const NOTE_LEVELS = {
  env: 'NOTE_LEVELS',
  output: 'note_levels',
  job: 'read-bumps',
  noun: 'note level',
  value: 'release-note levels',
};

const SECTIONS = [
  ['major', 'Major Changes'],
  ['minor', 'Minor Changes'],
  ['patch', 'Patch Changes'],
];

const CHANGESET_FILE = /\s*---([\s\S]*?)\n\s*---(\s*(?:\n|$)[\s\S]*)/;

export function changesetSummary(text) {
  const match = CHANGESET_FILE.exec(String(text ?? ''));
  if (!match)
    throw new Error(
      'changeset has no frontmatter delimited by "---"; Changesets cannot read it either.',
    );
  return match[2].trim();
}

export function noteLevel(releases, fixedGroup) {
  const cli = releases.filter(({ name, type }) => name === FIXED_GROUP_ANCHOR && type !== 'none');
  return maxReleaseType(
    cli.length > 0 ? cli : releases.filter(({ name }) => fixedGroup.includes(name)),
  );
}

export function renderEntry(summary) {
  const [first, ...rest] = summary.split('\n').map((line) => line.trimEnd());
  return [`- ${first}`, ...rest.map((line) => (line === '' ? '' : `  ${line}`))].join('\n');
}

const isLoose = (summary) => /\n[ \t]*\n/.test(summary);

const fileOrder = (a, b) => {
  const left = `${a.id}.md`;
  const right = `${b.id}.md`;
  return left < right ? -1 : left > right ? 1 : 0;
};

export function renderStableNotes(entries, { marked = false } = {}) {
  const sections = [];
  for (const [level, heading] of SECTIONS) {
    const items = entries.filter((entry) => entry.level === level).sort(fileOrder);
    if (items.length === 0) continue;
    const lines = [];
    items.forEach((entry, index) => {
      lines.push(renderEntry(entry.summary));
      if (index < items.length - 1 && isLoose(entry.summary)) lines.push('');
    });
    sections.push(`### ${heading}\n\n${lines.join('\n')}`);
  }
  if (sections.length === 0) return `${EMPTY_NOTES}\n`;
  const notes = sections.join('\n\n');
  return marked ? `${notes}\n\n${NOTES_SOURCE_MARKER}\n` : `${notes}\n`;
}

export function collectStableNotes({ commit, excludeTags = [], releasedTags = null }, git) {
  return unreleasedChangesetIds(git, commit, { excludeTags, releasedTags })
    .map((id) => ({
      id,
      level: git.noteLevelOf(commit, id),
      summary: changesetSummary(git.changesetText(commit, id)),
    }))
    .filter((entry) => entry.level !== null);
}

export function stableNotes({ commit, excludeTags = [], publishedTags = null }, git) {
  const entries = collectStableNotes({ commit, excludeTags, releasedTags: publishedTags }, git);
  return renderStableNotes(entries, { marked: Array.isArray(publishedTags) });
}

export function readPublishedStableTags({ releasesFile = '' } = {}) {
  try {
    return createShippedFixCheck(
      releasesFile === ''
        ? {}
        : { listReleases: () => parseReleaseListing(readFileSync(releasesFile, 'utf8')) },
    ).publishedStableTags();
  } catch (err) {
    console.error(
      `::warning::render-stable-notes: could not read the published stable Releases (${err instanceof Error ? err.message : String(err)}). ` +
        'The notes count every stable tag as released, so they may leave out changesets first tagged in a stable ' +
        'whose Release never published, and they carry no notes-source marker; the docs changelog lists no entry for this version until the body carries one.',
    );
    return null;
  }
}

export function noteReaderAt(cwd) {
  const git = gitAt(cwd);
  const fixedGroups = new Map();
  const fixedGroupAt = (sha) => {
    if (!fixedGroups.has(sha)) {
      fixedGroups.set(
        sha,
        fixedGroupOf(JSON.parse(runGit(['show', `${sha}:./.changeset/config.json`], cwd))),
      );
    }
    return fixedGroups.get(sha);
  };
  return {
    ...git,
    noteLevelOf: (sha, id) => {
      const text = git.changesetText(sha, id);
      const parsed = loadChangesets().parse(text);
      if (parsed.summary !== changesetSummary(text)) {
        throw new Error(
          `.changeset/${id}.md at ${sha}: the summary this renderer reads differs from the one Changesets reads, ` +
            'so its release note would not match the changelog.',
        );
      }
      return noteLevel(parsed.releases, fixedGroupAt(sha));
    },
  };
}

export const parseNoteLevels = (raw) => parseVerdicts(raw, NOTE_LEVELS);

export const serializeNoteLevels = serializeBumpVerdicts;

export const recordNoteLevels = (git, levels) => recordVerdicts(git, 'noteLevelOf', levels);

export const withNoteLevels = (git, levels) =>
  withVerdicts(git, 'noteLevelOf', levels, NOTE_LEVELS);

export function parseArgs(argv) {
  const args = { readLevels: false, commit: '', excludeTags: [], releasesFile: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--read-levels') args.readLevels = true;
    else if (arg === '--commit') args.commit = argv[++i] ?? '';
    else if (arg === '--releases') args.releasesFile = argv[++i] ?? '';
    else if (arg === '--exclude-tag') {
      const tag = argv[++i] ?? '';
      if (tag !== '') args.excludeTags.push(tag);
    } else throw new Error(`unknown argument '${arg}'`);
  }
  if (args.commit === '') throw new Error('--commit <sha> is required');
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const reader = noteReaderAt();
    const commit = reader.revParse(args.commit);
    if (args.readLevels) {
      const levels = new Map();
      const reading = recordNoteLevels(reader, levels);
      const ids = reader.changesetIds(commit);
      for (const id of ids) reading.noteLevelOf(commit, id);
      process.stderr.write(`Read the note level of ${ids.length} changeset(s) at ${commit}.\n`);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `note_levels=${serializeNoteLevels(levels)}\n`);
      }
      return;
    }
    const git =
      process.env.NOTE_LEVELS === undefined
        ? reader
        : withNoteLevels(reader, parseNoteLevels(process.env.NOTE_LEVELS));
    const publishedTags = readPublishedStableTags({ releasesFile: args.releasesFile });
    process.stdout.write(
      stableNotes({ commit, excludeTags: args.excludeTags, publishedTags }, git),
    );
  } catch (err) {
    console.error(
      `::error::render-stable-notes: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
