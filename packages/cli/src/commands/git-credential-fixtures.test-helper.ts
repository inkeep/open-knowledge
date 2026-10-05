import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shellSingleQuote } from '@inkeep/open-knowledge-core';

const CLI_PACKAGE_DIR = resolve(import.meta.dirname, '../..');

function phaseRecorderLines(phaseLog: string | undefined): string[] {
  return phaseLog === undefined
    ? []
    : [
        `const phase = stage => appendFileSync(${JSON.stringify(phaseLog)}, JSON.stringify({ stage, pid: process.pid, ppid: process.ppid, at: Date.now() }) + '\\n');`,
      ];
}

function recordCliCallLines(callLog: string, phaseLog?: string): string[] {
  return [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    ...phaseRecorderLines(phaseLog),
    ...(phaseLog === undefined ? [] : ["phase('wrapper:loaded');"]),
    'const args = process.argv.slice(2);',
    "const input = readFileSync(0, 'utf-8');",
    ...(phaseLog === undefined ? [] : ["phase('wrapper:input-ended');"]),
    'const fields = {};',
    "for (const line of input.split('\\n')) {",
    "  const at = line.indexOf('=');",
    '  if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);',
    '}',
    `appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, protocol: fields.protocol, host: fields.host }) + '\\n');`,
  ];
}

export interface RecordedHelperCall {
  label: string;
  operation: string;
  fields: Record<string, string>;
  relayToken: string | null;
}

export interface CliHelperCall {
  args: string[];
  protocol?: string;
  host?: string;
}

export function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

export function linesCarrying(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

export function gitConfigParameter(key: string, value: string): string {
  return `'${key}'='${value.replaceAll("'", "'\\''")}'`;
}

export function writeRecordingCredentialHelper(
  dir: string,
  log: string,
): (label: string) => string {
  const script = join(dir, 'recording-credential-helper.mjs');
  writeFileSync(
    script,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      'const [log, label, operation] = process.argv.slice(2);',
      'const fields = {};',
      "for (const line of readFileSync(0, 'utf-8').split('\\n')) {",
      "  const at = line.indexOf('=');",
      '  if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);',
      '}',
      'const relayToken = process.env.OK_GH_TOKEN ?? null;',
      "appendFileSync(log, JSON.stringify({ label, operation, fields, relayToken }) + '\\n');",
      '',
    ].join('\n'),
    'utf-8',
  );
  return (label) =>
    `!${shellSingleQuote(process.execPath)} ${shellSingleQuote(script)} ${shellSingleQuote(log)} ${label}`;
}

export function writeCliCredentialStandIn(options: {
  dir: string;
  callLog: string;
  authFile: string;
  phaseLog?: string;
}): string {
  const runner = join(options.dir, 'ok-git-credential-get.mts');
  const moduleUrl = (path: string) =>
    JSON.stringify(pathToFileURL(join(CLI_PACKAGE_DIR, path)).href);
  writeFileSync(
    runner,
    [
      `import { FileBackend } from ${moduleUrl('src/auth/token-store.ts')};`,
      `import { handleCredentialGet } from ${moduleUrl('src/commands/auth/git-credential-get.ts')};`,
      ...(options.phaseLog === undefined
        ? []
        : [
            "import { appendFileSync } from 'node:fs';",
            ...phaseRecorderLines(options.phaseLog),
            "phase('module-loaded');",
            "process.stdin.once('end', () => phase('input-ended'));",
          ]),
      `const store = new FileBackend(${JSON.stringify(options.authFile)});`,
      'const code = await handleCredentialGet(process.stdin, process.stdout, store);',
      ...(options.phaseLog === undefined ? [] : ["phase('handler-returned');"]),
      'process.exit(code);',
      '',
    ].join('\n'),
    'utf-8',
  );
  const entry = join(options.dir, 'ok-cli.mjs');
  writeFileSync(
    entry,
    [
      ...recordCliCallLines(options.callLog, options.phaseLog),
      "if (args.join(' ') !== 'auth git-credential get') process.exit(1);",
      ...(options.phaseLog === undefined ? [] : ["phase('helper:start');"]),
      `const helper = spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', ${JSON.stringify(runner)}], { cwd: ${JSON.stringify(CLI_PACKAGE_DIR)}, input, stdio: ['pipe', 'inherit', 'inherit'] });`,
      ...(options.phaseLog === undefined ? [] : ["phase('helper:returned');"]),
      'process.exit(helper.status ?? 1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  return entry;
}

export function writeCliEntryLauncher(options: { dir: string; callLog: string }): string {
  const entry = join(options.dir, 'ok-cli-entry.mjs');
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const cli = join(CLI_PACKAGE_DIR, 'src', 'cli.ts');
  writeFileSync(
    entry,
    [
      ...recordCliCallLines(options.callLog),
      `const cli = spawnSync(process.execPath, ['--conditions=development', '--import', ${JSON.stringify(tsxLoader)}, ${JSON.stringify(cli)}, ...args], { input, stdio: ['pipe', 'inherit', 'inherit'] });`,
      'process.exit(cli.status ?? 1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  return entry;
}
