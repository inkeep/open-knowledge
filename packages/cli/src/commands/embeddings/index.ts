/**
 * `ok embeddings` — manage the semantic-search embeddings provider key + status.
 *
 * Subcommands:
 *   - `set-key` / `clear-key`  store / remove the API key for THIS project's
 *     configured endpoint (keys are per-project + per-endpoint now).
 *   - `list`      show every project + endpoint that has a stored key.
 *   - `set-url` / `clear-url`  set / reset `search.semantic.baseUrl` (project-local).
 *   - `set-model` / `clear-model`  set / reset `search.semantic.model` (project-local).
 *   - `enable` / `disable`  flip `search.semantic.enabled` for the project (project-local).
 *   - `status`    show key presence + enabled/capability/coverage (per-project).
 *
 * The key is read from stdin (piped) or a hidden prompt, stored only in the
 * 0600 `~/.ok/secrets.yml` file keyed by (project, endpoint) — NOT the OS
 * keychain (a keychain read prompts on the agent-triggered search path), and
 * never in the project tree. NEVER echoed, logged, or written to project
 * config. A sibling of `ok auth` (GitHub-specific, which DOES use the keychain).
 */

import { resolve } from 'node:path';
import {
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  humanFormat,
} from '@inkeep/open-knowledge-core';
import { writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import {
  EMBEDDINGS_API_KEY_ENV,
  isProcessAlive,
  readProjectLocalSemanticConfig,
  readServerLock,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import password from '@inquirer/password';
import { Command } from 'commander';
import {
  createEmbeddingsSecretStore,
  resolveEmbeddingsCredential,
} from '../../auth/embeddings-key-store.ts';

/** Read the key from piped stdin, else a hidden interactive prompt. */
async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8').trim();
  }
  return (await password({ message: 'Enter embeddings provider API key:' })).trim();
}

// Read `search.semantic.*` through the SAME project-local-only resolver the
// server uses (`readProjectLocalSemanticConfig`), so `status` can never report a
// different enabled/capability than the running server. The working dir IS the
// project root (matches how `ok start` resolves `projectDir`).
function readSemanticConfig(projectDir: string) {
  return readProjectLocalSemanticConfig(projectDir);
}

/**
 * Whether a key resolves for this project's configured endpoint, via the SAME
 * resolver the server uses (project key → env on the default host → keyless
 * loopback), so `status` can't disagree with what a search would do.
 */
async function resolveKeyPresence(
  projectDir: string,
  baseUrl: string,
): Promise<{ present: boolean; notRequired: boolean; source: 'project' | 'file' | 'env' | null }> {
  const cred = await resolveEmbeddingsCredential(
    createEmbeddingsSecretStore(),
    projectDir,
    baseUrl,
  );
  if (cred.apiKey) {
    return { present: true, notRequired: false, source: cred.source as 'project' | 'file' | 'env' };
  }
  return { present: false, notRequired: cred.keyless, source: null };
}

/**
 * Best-effort live coverage from the project's running server (discovered via
 * `server.lock`). Returns null — never throws — when no server is running or the
 * probe fails, so `status` works offline. The probe is the read-only,
 * side-effect-free `/api/semantic-status` (no embed, no egress, no keychain).
 */
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
    .description("Store the embeddings API key for THIS project's configured endpoint")
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (opts: { cwd?: string }) => {
      const key = await readKey();
      if (!key) {
        process.stderr.write('No key provided.\n');
        process.exitCode = 1;
        return;
      }
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const { baseUrl } = readSemanticConfig(projectDir);
      try {
        await createEmbeddingsSecretStore().setForProject(projectDir, baseUrl, key);
      } catch (e) {
        // The CLI is the headless path (keys piped from a secrets manager), so a
        // disk-write failure must report clearly rather than dump a stack.
        process.stderr.write(
          `Failed to store the embeddings key: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      // Never echo the key.
      process.stderr.write(
        `✓ Embeddings API key stored for ${baseUrl}\n` +
          '  (kept in ~/.ok/secrets.yml, 0600, this machine only — never in the project).\n' +
          '  Enable semantic search with `ok embeddings enable`, or in\n' +
          '  OK Desktop → Settings → This project → Search.\n',
      );
    });
}

function clearKeyCommand(): Command {
  return new Command('clear-key')
    .description("Remove the embeddings API key for THIS project's configured endpoint")
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (opts: { cwd?: string }) => {
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const { baseUrl } = readSemanticConfig(projectDir);
      let removed: boolean;
      try {
        removed = await createEmbeddingsSecretStore().clearForProject(projectDir, baseUrl);
      } catch (e) {
        process.stderr.write(
          `Failed to clear the embeddings key: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (!removed) {
        process.stderr.write(`No stored embeddings key found for ${baseUrl}.\n`);
        return;
      }
      process.stderr.write(`✓ Embeddings API key cleared for ${baseUrl}.\n`);
    });
}

function listCommand(): Command {
  return new Command('list')
    .description('List every project + endpoint that has a stored embeddings key')
    .action(async () => {
      const projects = await createEmbeddingsSecretStore().listProjects();
      if (projects.length === 0) {
        process.stderr.write('No project embeddings keys stored.\n');
        return;
      }
      // Read-only view; also the way to spot orphaned entries from projects that
      // were moved or deleted (their path no longer exists on disk).
      const lines: string[] = ['Stored embeddings keys (this machine):', ''];
      for (const { projectKey, endpoints } of projects) {
        lines.push(`  ${projectKey}`);
        for (const { endpoint, hint } of endpoints) {
          lines.push(`    ${endpoint}  →  ${hint ? `••••${hint}` : 'set'}`);
        }
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}

/**
 * `set-url` / `clear-url` set / reset `search.semantic.baseUrl` in the
 * project-local config — the same field + scope the Settings endpoint input
 * uses, so a running server picks the change up live. `set-url` validates the
 * URL against the SAME rule the server enforces before sending the key
 * (`checkEmbeddingsBaseUrl`: https, or http only for loopback) so a
 * guaranteed-to-fail endpoint is rejected here instead of degrading to lexical
 * at warm time. `clear-url` writes the default endpoint back (mirrors clearing
 * the Settings field). Human-run (the field is `agentSettable: false`).
 */
function setUrlCommand(): Command {
  return new Command('set-url')
    .description('Set the embeddings API endpoint for this project (project-local)')
    .argument('<url>', 'OpenAI-compatible base URL, e.g. https://api.openai.com/v1')
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (url: string, opts: { cwd?: string }) => {
      const baseUrl = url.trim();
      const problem = checkEmbeddingsBaseUrl(baseUrl);
      if (problem !== null) {
        process.stderr.write(
          problem === 'invalid-url'
            ? `Not a valid URL: ${url}\n`
            : `Refusing an insecure endpoint: use https:// (http:// is allowed only for localhost). Got: ${url}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const result = await writeConfigPatch({
        cwd: projectDir,
        scope: 'project-local',
        patch: { search: { semantic: { baseUrl } } },
      });
      if (!result.ok) {
        process.stderr.write(
          `Failed to set the embeddings endpoint — ${humanFormat(result.error)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`✓ Embeddings endpoint set to ${baseUrl} for ${projectDir}\n`);
    });
}

function clearUrlCommand(): Command {
  return new Command('clear-url')
    .description('Reset the embeddings API endpoint to the default OpenAI endpoint (project-local)')
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (opts: { cwd?: string }) => {
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const result = await writeConfigPatch({
        cwd: projectDir,
        scope: 'project-local',
        patch: { search: { semantic: { baseUrl: DEFAULT_EMBEDDINGS_BASE_URL } } },
      });
      if (!result.ok) {
        process.stderr.write(
          `Failed to reset the embeddings endpoint — ${humanFormat(result.error)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `✓ Embeddings endpoint reset to ${DEFAULT_EMBEDDINGS_BASE_URL} for ${projectDir}\n`,
      );
    });
}

/**
 * `set-model` / `clear-model` are the endpoint commands' other half: a custom
 * endpoint is only usable once you can also name the model it serves. Without
 * these the persona this whole feature targets — someone running their own
 * server, often headless — can set the URL from the CLI but has to hand-edit
 * `config.yml` for the model.
 *
 * Free-text by design (no preset list): whatever the endpoint serves is valid,
 * and a curated catalog would rot. The vector size is detected from the
 * provider, so there is no matching dimensions command.
 */
function setModelCommand(): Command {
  return new Command('set-model')
    .description('Set the embeddings model for this project (project-local)')
    .argument('<model>', 'Model id served by the configured endpoint, e.g. nomic-embed-text')
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (modelArg: string, opts: { cwd?: string }) => {
      const model = modelArg.trim();
      if (!model) {
        process.stderr.write('Model id cannot be empty. Use `clear-model` to reset the default.\n');
        process.exitCode = 1;
        return;
      }
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const result = await writeConfigPatch({
        cwd: projectDir,
        scope: 'project-local',
        patch: { search: { semantic: { model } } },
      });
      if (!result.ok) {
        process.stderr.write(`Failed to set the embeddings model — ${humanFormat(result.error)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `✓ Embeddings model set to ${model} for ${projectDir}\n` +
          '  Changing the model re-embeds the corpus on the next search.\n',
      );
    });
}

function clearModelCommand(): Command {
  return new Command('clear-model')
    .description(`Reset the embeddings model to ${DEFAULT_EMBEDDINGS_MODEL} (project-local)`)
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (opts: { cwd?: string }) => {
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const result = await writeConfigPatch({
        cwd: projectDir,
        scope: 'project-local',
        patch: { search: { semantic: { model: DEFAULT_EMBEDDINGS_MODEL } } },
      });
      if (!result.ok) {
        process.stderr.write(
          `Failed to reset the embeddings model — ${humanFormat(result.error)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `✓ Embeddings model reset to ${DEFAULT_EMBEDDINGS_MODEL} for ${projectDir}\n`,
      );
    });
}

/**
 * `enable` / `disable` flip `search.semantic.enabled` in the project-local config
 * (`<project>/.ok/local/config.yml`) — the same field + scope the Settings toggle
 * and the server's config watcher use, so a running server picks the change up
 * live. Human-run (consistent with the field's `agentSettable: false`).
 */
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
        const cfg = readSemanticConfig(projectDir);
        const { present, notRequired } = await resolveKeyPresence(projectDir, cfg.baseUrl);
        if (!present && !notRequired) {
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
      const {
        present: hasKey,
        notRequired: keyNotRequired,
        source: keySource,
      } = await resolveKeyPresence(projectDir, cfg.baseUrl);
      const capable = cfg.enabled && (hasKey || keyNotRequired);
      // Coverage is only meaningful once capable; skip the server probe otherwise.
      const coverage = capable ? await fetchLiveCoverage(projectDir) : null;

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({
            project: projectDir,
            key: { present: hasKey, notRequired: keyNotRequired, source: keySource },
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
        ? `set for this endpoint — ${keySource === 'env' ? `environment (${EMBEDDINGS_API_KEY_ENV})` : '~/.ok/secrets.yml'}`
        : keyNotRequired
          ? 'not required (localhost endpoint)'
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
        '  This project:',
        `    enabled:    ${cfg.enabled ? 'yes' : 'no'}`,
        `    API key:    ${keyLabel}`,
        `    capability: ${capable ? 'AVAILABLE' : 'unavailable (search stays lexical)'}`,
        ...(coverageLabel ? [`    coverage:   ${coverageLabel}`] : []),
        `    provider:   ${cfg.baseUrl}`,
        `    model:      ${cfg.model}`,
        `    dimensions: ${cfg.dimensions ?? 'auto (detected from the endpoint)'}`,
      ];

      const hints: string[] = [];
      if (!hasKey && !keyNotRequired) {
        hints.push(`Set a key:  ok embeddings set-key   (or export ${EMBEDDINGS_API_KEY_ENV})`);
      }
      if (!cfg.enabled) {
        hints.push('Enable it:  ok embeddings enable   (in this project folder)');
      }
      if (hints.length > 0) lines.push('', ...hints.map((h) => `  ${h}`));

      process.stdout.write(`${lines.join('\n')}\n`);
    });
}

/** Build the `embeddings` command group. */
export function embeddingsCommand(): Command {
  return new Command('embeddings')
    .description('Manage the semantic-search embeddings provider key + status')
    .addCommand(setKeyCommand())
    .addCommand(clearKeyCommand())
    .addCommand(setUrlCommand())
    .addCommand(clearUrlCommand())
    .addCommand(setModelCommand())
    .addCommand(clearModelCommand())
    .addCommand(toggleEnabledCommand('enable', true))
    .addCommand(toggleEnabledCommand('disable', false))
    .addCommand(listCommand())
    .addCommand(statusCommand());
}
