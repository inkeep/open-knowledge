import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ciFiles } from './ci-files.mjs';

const PROXIES = new Set([
  'cargo',
  'cargo-clippy',
  'cargo-fmt',
  'cargo-miri',
  'clippy-driver',
  'rls',
  'rust-analyzer',
  'rust-gdb',
  'rust-gdbgui',
  'rust-lldb',
  'rustc',
  'rustdoc',
  'rustfmt',
  'rustup',
]);

export function ciDocuments(root) {
  return ciFiles(root).map((file) => ({
    file,
    document: parse(readFileSync(join(root, file), 'utf8')),
  }));
}

const stepLabel = (step, index) => step.name ?? step.uses ?? `step ${index + 1}`;

function* stepPlaces(file, job, steps) {
  for (const [index, step] of (steps ?? []).entries()) {
    yield { file, job, step: stepLabel(step, index), env: step.env, where: 'the step env', body: step };
  }
}

function* places(file, document) {
  if (document?.jobs !== undefined) {
    yield { file, job: null, step: null, env: document.env, where: 'the workflow env' };
    for (const [job, body] of Object.entries(document.jobs)) {
      yield { file, job, step: null, env: body.env, where: 'the job env' };
      yield { file, job, step: null, env: body.container?.env, where: "the job container's env" };
      yield* stepPlaces(file, job, body.steps);
    }
    return;
  }
  if (document?.runs !== undefined) {
    yield* stepPlaces(file, null, document.runs.steps);
    return;
  }
  throw new Error(`${file} is neither a workflow (no jobs) nor an action (no runs)`);
}

const INSTALL_OPTIONS = ['--profile', '-c', '--component', '-t', '--target'];
const NAMING_SUBCOMMANDS = new Map([
  ['default', []],
  ['install', INSTALL_OPTIONS],
  ['override set', ['--path']],
  ['run', []],
  ['toolchain install', INSTALL_OPTIONS],
  ['update', []],
]);
const NESTED = new Set(['override', 'toolchain']);
const REDIRECT = /^\d*(?:[<>]|&>)/;
const BARE_REDIRECT = /^\d*(?:>>?|<|&>>?|>\|)$/;

const unquoted = (word) => word.replace(/^["']|["']$/g, '');
const toolName = (word) =>
  unquoted(word)
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, '');
const invokesRust = (word) => PROXIES.has(toolName(word));
const mentionsVariable = (word) => /RUSTUP_TOOLCHAIN/i.test(word);

function withoutComment(line) {
  let quote = null;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') at += 1;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '\\') at += 1;
    else if (char === '#' && (at === 0 || /[\s;&|(]/.test(line[at - 1]))) return line.slice(0, at);
  }
  return line;
}

function shellCommands(run) {
  const expressions = [];
  return run
    .replace(/\$\{\{[\s\S]*?\}\}/g, (expression) => `\uE000${expressions.push(expression) - 1}\uE000`)
    .split(/\r?\n/)
    .map(withoutComment)
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split(/\n|&&|\|\||[;|`()]|\$\(/)
    .map((command) =>
      command
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.replace(/\uE000(\d+)\uE000/g, (_match, index) => expressions[index])),
    )
    .filter((words) => words.some((word) => invokesRust(word) || mentionsVariable(word)));
}

function toolchainOption(words) {
  const at = words.findIndex((word) => word === '--toolchain' || word.startsWith('--toolchain='));
  if (at === -1) return undefined;
  return words[at].includes('=') ? words[at].slice(words[at].indexOf('=') + 1) : words[at + 1];
}

function rustupNaming(words) {
  const option = toolchainOption(words);
  if (option !== undefined) return option;
  let at = 0;
  while (words[at]?.startsWith('-')) at += 1;
  if (words[at]?.startsWith('+')) return words[at];
  const subcommand = NESTED.has(words[at]) ? `${words[at]} ${words[at + 1]}` : words[at];
  const valueOptions = NAMING_SUBCOMMANDS.get(subcommand);
  if (valueOptions === undefined) return undefined;
  const operands = words.slice(at + subcommand.split(' ').length);
  for (let index = 0; index < operands.length; index += 1) {
    const word = operands[index];
    if (REDIRECT.test(word)) {
      if (BARE_REDIRECT.test(word)) index += 1;
    } else if (!word.startsWith('-')) return word;
    else if (valueOptions.includes(word)) index += 1;
  }
  return undefined;
}

const assignsVariable = (words) =>
  words.some(
    (word, index) =>
      /^(?:\$env:)?RUSTUP_TOOLCHAIN=/i.test(unquoted(word)) ||
      (/^(?:\$env:)?RUSTUP_TOOLCHAIN$/i.test(unquoted(word)) && words[index + 1]?.startsWith('=')),
  );

function commandNaming(words) {
  for (const [index, word] of words.entries()) {
    if (!invokesRust(word)) continue;
    const rest = words.slice(index + 1).map(unquoted);
    const named =
      toolName(word) === 'rustup' ? rustupNaming(rest) : rest[0]?.startsWith('+') ? rest[0] : undefined;
    if (named !== undefined) return `names ${named}`;
  }
  return assignsVariable(words) ? 'sets RUSTUP_TOOLCHAIN' : undefined;
}

function actionNaming(step) {
  if (typeof step.uses !== 'string') return undefined;
  const input = Object.entries(step.with ?? {}).find(([key]) => /^toolchain$/i.test(key));
  if (input !== undefined) return `passes ${input[0]}: ${input[1]} to ${step.uses}`;
  return /^dtolnay\/rust-toolchain(?:[/@]|$)/i.test(step.uses) ? `uses ${step.uses}` : undefined;
}

export function rustToolchainSites(documents) {
  if (documents.length === 0) {
    throw new Error('no workflow or action was given, so nothing was judged');
  }
  const commands = [];
  const findings = [];
  for (const { file, document } of documents) {
    for (const { body, env, where, ...site } of places(file, document)) {
      const pin = Object.keys(env ?? {}).find((key) => /^RUSTUP_TOOLCHAIN$/i.test(key));
      if (pin !== undefined) {
        findings.push({ ...site, kind: 'env', detail: `sets ${pin}: ${env[pin]} in ${where}` });
      }
      if (body === undefined) continue;
      const action = actionNaming(body);
      if (action !== undefined) findings.push({ ...site, kind: 'action', detail: action });
      if (typeof body.run === 'string') {
        for (const words of shellCommands(body.run)) {
          const command = words.join(' ');
          commands.push({ ...site, command });
          const naming = commandNaming(words);
          if (naming !== undefined) {
            findings.push({ ...site, kind: 'command', detail: `${command} ${naming}` });
          }
        }
      }
    }
  }
  return { commands, findings };
}
