import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChangesets } from './compute-next-beta.mjs';

const PASS = "No 'major' bumps in changesets.";
const root = fileURLToPath(new URL('..', import.meta.url));
const changesetDir = join(root, '.changeset');

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

export async function main() {
  if (!existsSync(changesetDir)) {
    console.log(PASS);
    return 0;
  }
  let changesets;
  try {
    changesets = loadChangesets(root);
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
  const violations = entries
    .filter(({ releases }) => releases.some(({ type }) => type === 'major'))
    .map(({ id }) => changesetsEntryPath(id));
  if (violations.length > 0) {
    console.error(
      `::error::Forbidden 'major' bump in changeset(s): ${violations.sort().join(' ')}`,
    );
    console.error(
      "Open Knowledge is pre-1.0 — declare 'minor' for breaking changes, 'patch' for fixes.",
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
