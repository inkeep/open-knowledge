import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatterBumpType, pendingChangesetFiles } from './compute-next-beta.mjs';
import { changesetIdsFromTreePaths } from './compute-stable-version.mjs';

const PASS = "No 'major' bumps in changesets.";
const root = fileURLToPath(new URL('..', import.meta.url));
const changesetDir = join(root, '.changeset');

function loadChangesets() {
  const cliRequire = createRequire(
    createRequire(join(root, 'package.json')).resolve('@changesets/cli/package.json'),
  );
  const readerRequire = createRequire(cliRequire.resolve('@changesets/read'));
  return {
    read: cliRequire('@changesets/read').default,
    parse: readerRequire('@changesets/parse').default,
  };
}

function parseRejection(parse, file) {
  try {
    parse(readFileSync(join(changesetDir, file), 'utf8'));
  } catch (error) {
    return error.message;
  }
  return null;
}

function readByChangesets(file) {
  return !file.startsWith('.') && file.endsWith('.md') && !/^README\.md$/i.test(file);
}

function unreadableChangesets(parse, error) {
  const rejections = readdirSync(changesetDir)
    .filter(readByChangesets)
    .map((file) => ({ path: `.changeset/${file}`, message: parseRejection(parse, file) }))
    .filter(({ message }) => message !== null);
  const paths = rejections.map(({ path }) => path);
  return rejections.some(({ message }) => message === error.message)
    ? paths
    : [...paths, '.changeset'];
}

function refuse(subject, error) {
  console.error(`::error::Refusing to report a pass: ${subject}`);
  console.error(error.message);
  return 1;
}

function changesetsEntryPath(id) {
  return lstatSync(join(changesetDir, id), { throwIfNoEntry: false })?.isDirectory()
    ? `.changeset/${id}/changes.json`
    : `.changeset/${id}.md`;
}

function versionReaderPaths() {
  const tree = readdirSync(changesetDir, { recursive: true })
    .map((entry) => `.changeset/${entry.split(sep).join('/')}`)
    .filter((path) => !statSync(join(root, path)).isDirectory());
  return [
    ...pendingChangesetFiles(changesetDir).map((file) => `.changeset/${file}`),
    ...changesetIdsFromTreePaths(tree).map((id) => `.changeset/${id}.md`),
  ];
}

export async function main() {
  if (!existsSync(changesetDir)) {
    console.log(PASS);
    return 0;
  }
  let changesets;
  try {
    changesets = loadChangesets();
  } catch (error) {
    return refuse(`Changesets could not be loaded from ${root}`, error);
  }
  let entries;
  const readRejections = [];
  const recordReadRejection = (reason) => readRejections.push(reason);
  process.on('unhandledRejection', recordReadRejection);
  try {
    entries = await changesets.read(root);
  } catch (error) {
    return refuse(
      `Changesets could not read ${unreadableChangesets(changesets.parse, error).join(' ')}`,
      error,
    );
  } finally {
    process.off('unhandledRejection', recordReadRejection);
  }
  if (readRejections.length > 0) {
    return refuse('Changesets could not read .changeset', readRejections[0]);
  }
  let violations;
  try {
    violations = new Set([
      ...entries
        .filter(({ releases }) => releases.some(({ type }) => type === 'major'))
        .map(({ id }) => changesetsEntryPath(id)),
      ...versionReaderPaths().filter(
        (path) => parseFrontmatterBumpType(readFileSync(join(root, path), 'utf8')) === 'major',
      ),
    ]);
  } catch (error) {
    return refuse('the release version readers could not read .changeset', error);
  }
  if (violations.size > 0) {
    console.error(
      `::error::Forbidden 'major' bump in changeset(s): ${[...violations].sort().join(' ')}`,
    );
    console.error(
      "Open Knowledge is pre-1.0 — declare 'minor' for breaking changes, 'patch' for fixes.",
    );
    console.error(
      "The release version scripts read the frontmatter as raw text and count 'major' wherever it ends a line after ':' and optional whitespace, YAML comments included.",
    );
    console.error(
      'See .changeset/README.md. 1.0.0 is a deliberate team decision, not a single changeset.',
    );
    return 1;
  }
  console.log(PASS);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
