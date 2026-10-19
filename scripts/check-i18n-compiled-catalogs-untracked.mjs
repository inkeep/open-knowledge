#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitCleanEnv } from './git-clean-env.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALES_DIR = 'packages/app/src/locales';
const GENERATED_CATALOG =
  /^packages\/app\/src\/locales\/(?:[^/]+\/messages\.json|pseudo\/messages\.po)$/;

function git(args) {
  return spawnSync('git', args, { cwd: OK_ROOT, env: gitCleanEnv(), encoding: 'utf8' });
}

function failureOf(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `was killed by ${result.signal}`;
  return `exited ${result.status}: ${(result.stderr ?? '').trim()}`;
}

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function main() {
  const listed = git(['ls-files', '-z', '--', LOCALES_DIR]);
  if (listed.error || listed.status !== 0) {
    console.error(
      `ERROR: could not list the tracked paths under ${LOCALES_DIR}, so whether git tracks a generated i18n catalog is unknown.`,
    );
    console.error(`  git ls-files ${failureOf(listed)}`);
    return 2;
  }
  const tracked = [...new Set(listed.stdout.split('\0').filter(Boolean))];
  if (tracked.length === 0) {
    console.error(
      `ERROR: git lists no tracked path under ${LOCALES_DIR}, so this check has nothing to examine. Run it from an Open Knowledge checkout.`,
    );
    return 2;
  }

  const generated = tracked.filter((path) => GENERATED_CATALOG.test(path));
  if (generated.length === 0) {
    console.log(
      `i18n: git tracks no generated catalog among ${tracked.length} tracked path(s) under ${LOCALES_DIR}.`,
    );
    return 0;
  }

  console.error('ERROR: git tracks generated i18n catalogs.');
  console.error('');
  console.error('  The catalog compile writes every locale messages.json and derives the');
  console.error('  pseudo locale from en, so packages/app/.gitignore ignores both and only');
  console.error('  the other messages.po catalogs are committed. Tracked here:');
  for (const path of generated) console.error(`    ${path}`);
  console.error('');
  console.error('  Fix: take them out of the index, keeping the files on disk,');
  console.error(
    `    git -C ${shellQuote(OK_ROOT)} rm --cached -- ${generated.map(shellQuote).join(' ')}`,
  );
  console.error('  then commit.');
  console.error('  A merge conflict on these paths resolved with git add keeps them tracked;');
  console.error('  git rm --cached is the resolution.');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main());
}
