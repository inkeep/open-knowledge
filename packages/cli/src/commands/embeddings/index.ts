
import { resolve } from 'node:path';
import { humanFormat } from '@inkeep/open-knowledge-core';
import { writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import {
  DEFAULT_EMBEDDINGS_DIMENSIONS,
  EMBEDDINGS_API_KEY_ENV,
  isProcessAlive,
  readProjectLocalSemanticConfig,
  readServerLock,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import password from '@inquirer/password';
import { Command } from 'commander';
import {
  clearEmbeddingsKeyFromAllBackends,
  createEmbeddingsSecretStore,
  describeStoredEmbeddingsKey,
} from '../../auth/embeddings-key-store.ts';

async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8').trim();
  }
  return (await password({ message: 'Enter OpenAI embeddings API key:' })).trim();
}

function readSemanticConfig(projectDir: string) {
  return readProjectLocalSemanticConfig(projectDir);
}

async function resolveKeyPresence(): Promise<{ present: boolean; source: 'file' | 'env' | null }> {
  const stored = await describeStoredEmbeddingsKey();
  if (stored.file) return { present: true, source: 'file' };
  if (process.env[EMBEDDINGS_API_KEY_ENV]) return { present: true, source: 'env' };
  return { present: false, source: null };
}

async function fetchLiveCoverage(
  projectDir: string,
): Promise<{ embedded: number; total: number } | null> {
  try {
    const lock = readServerLock(resolveLockDir(projectDir));
    if (!lock || lock.port <= 0 || !isProcessAlive(lock.pid)) return null;
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/semantic-status`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { embedded?: unknown; total?: unknown };
    if (typeof body.embedded !== 'number' || typeof body.total !== 'number') return null;
    return { embedded: body.embedded, total: body.total };
  } catch {
    return null;
  }
}

function setKeyCommand(): Command {
  return new Command('set-key')
    .description('Store your OpenAI embeddings API key in ~/.ok/secrets.yml')
    .action(async () => {
      const key = await readKey();
      if (!key) {
        process.stderr.write('No key provided.\n');
        process.exitCode = 1;
        return;
      }
      await createEmbeddingsSecretStore().set(key);
      process.stderr.write(
        '✓ OpenAI embeddings API key stored in ~/.ok/secrets.yml (0600, this machine only).\n' +
          'Now enable it per project — the easiest path is OK Desktop → Settings → This\n' +
          'project → Search (a toggle with an egress-confirmation prompt), or run\n' +
          '`ok embeddings enable` in the project folder.\n',
      );
    });
}

function clearKeyCommand(): Command {
  return new Command('clear-key')
    .description('Remove your stored OpenAI embeddings API key')
    .action(async () => {
      const { touched } = await clearEmbeddingsKeyFromAllBackends();
      if (touched.length === 0) {
        process.stderr.write('No stored OpenAI embeddings key found.\n');
        return;
      }
      process.stderr.write(`✓ OpenAI embeddings API key cleared (${touched.join(', ')}).\n`);
    });
}

function toggleEnabledCommand(name: 'enable' | 'disable', value: boolean): Command {
  return new Command(name)
    .description(`Turn semantic search ${value ? 'on' : 'off'} for this project (project-local)`)
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (opts: { cwd?: string }) => {
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const result = await writeConfigPatch({
        cwd: projectDir,
        scope: 'project-local',
        patch: { search: { semantic: { enabled: value } } },
      });
      if (!result.ok) {
        process.stderr.write(`Failed to ${name} semantic search — ${humanFormat(result.error)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `✓ Semantic search ${value ? 'enabled' : 'disabled'} for ${projectDir}\n`,
      );
      if (value) {
        const { present } = await resolveKeyPresence();
        if (!present) {
          process.stderr.write(
            '  Note: no API key set yet — run `ok embeddings set-key`. Until then, search stays lexical.\n',
          );
        }
      }
    });
}

function statusCommand(): Command {
  return new Command('status')
    .description('Show semantic-search capability: key presence, enabled, coverage, provider')
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .option('--json', 'Output JSON', false)
    .action(async (opts: { cwd?: string; json?: boolean }) => {
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const cfg = readSemanticConfig(projectDir);
      const { present: hasKey, source: keySource } = await resolveKeyPresence();
      const capable = cfg.enabled && hasKey;
      const coverage = capable ? await fetchLiveCoverage(projectDir) : null;

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({
            project: projectDir,
            machine: { keyPresent: hasKey, keySource },
            project_config: {
              enabled: cfg.enabled,
              capable,
              coverage: coverage ? { embedded: coverage.embedded, total: coverage.total } : null,
              provider: {
                baseUrl: cfg.baseUrl,
                model: cfg.model,
                dimensions: cfg.dimensions ?? null,
              },
            },
          })}\n`,
        );
        return;
      }

      const keyLabel = hasKey
        ? `set — ${keySource === 'env' ? `environment (${EMBEDDINGS_API_KEY_ENV})` : '~/.ok/secrets.yml'}`
        : 'not set';
      const coverageLabel = !capable
        ? null
        : coverage
          ? `${coverage.embedded} / ${coverage.total} pages embedded`
          : 'server not running — start it to index (or it has not embedded yet)';

      const lines = [
        'Semantic search',
        `  project:     ${projectDir}`,
        '',
        '  This machine (all projects):',
        `    API key:    ${keyLabel}`,
        '',
        '  This project:',
        `    enabled:    ${cfg.enabled ? 'yes' : 'no'}`,
        `    capability: ${capable ? 'AVAILABLE' : 'unavailable (search stays lexical)'}`,
        ...(coverageLabel ? [`    coverage:   ${coverageLabel}`] : []),
        `    provider:   ${cfg.baseUrl}`,
        `    model:      ${cfg.model}`,
        `    dimensions: ${cfg.dimensions ?? `native (${DEFAULT_EMBEDDINGS_DIMENSIONS})`}`,
      ];

      const hints: string[] = [];
      if (!hasKey) {
        hints.push(`Set a key:  ok embeddings set-key   (or export ${EMBEDDINGS_API_KEY_ENV})`);
      }
      if (!cfg.enabled) {
        hints.push('Enable it:  ok embeddings enable   (in this project folder)');
      }
      if (hints.length > 0) lines.push('', ...hints.map((h) => `  ${h}`));

      process.stdout.write(`${lines.join('\n')}\n`);
    });
}

export function embeddingsCommand(): Command {
  return new Command('embeddings')
    .description('Manage the semantic-search embeddings provider key + status')
    .addCommand(setKeyCommand())
    .addCommand(clearKeyCommand())
    .addCommand(toggleEnabledCommand('enable', true))
    .addCommand(toggleEnabledCommand('disable', false))
    .addCommand(statusCommand());
}
