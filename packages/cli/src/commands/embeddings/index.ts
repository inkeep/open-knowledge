import { resolve } from 'node:path';
import {
  checkEmbeddingsBaseUrl,
  classifySemanticProviderError,
  currentCliCommandName,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  humanFormat,
  isSemanticSearchOffered,
  OK_USER_HOME_SECRETS_FILE,
  okUserHomeDisplayPath,
  type SemanticIndexStatus,
  SemanticIndexStatusSchema,
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
  EmbeddingsSecretStoreError,
  resolveEmbeddingsCredential,
} from '../../auth/embeddings-key-store.ts';

function credentialStoreError(error: unknown): EmbeddingsSecretStoreError {
  return error instanceof EmbeddingsSecretStoreError
    ? error
    : new EmbeddingsSecretStoreError('native_access');
}

function credentialFailureMessage(error: unknown): string {
  const failure = credentialStoreError(error);
  const diagnostic = failure.cause;
  return diagnostic
    ? `${failure.message} [${diagnostic.phase}; ${diagnostic.name}; ${diagnostic.code}]`
    : failure.message;
}

async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8').trim();
  }
  return (await password({ message: 'Enter embeddings provider API key:' })).trim();
}

function readSemanticConfig(projectDir: string) {
  return readProjectLocalSemanticConfig(projectDir);
}

async function resolveKeyPresence(
  projectDir: string,
  baseUrl: string,
): Promise<{
  present: boolean;
  notRequired: boolean;
  source: 'project' | 'file' | 'env' | null;
  storage: 'keyring' | 'file' | null;
  error: EmbeddingsSecretStoreError | null;
}> {
  const store = createEmbeddingsSecretStore();
  const cred = await resolveEmbeddingsCredential(store, projectDir, baseUrl).catch(
    credentialStoreError,
  );
  if (cred instanceof EmbeddingsSecretStoreError) {
    return { present: false, notRequired: false, source: null, storage: null, error: cred };
  }
  if (cred.apiKey) {
    return {
      present: true,
      notRequired: false,
      source: cred.source as 'project' | 'file' | 'env',
      storage: cred.source === 'env' ? null : store.backend,
      error: null,
    };
  }
  return {
    present: false,
    notRequired: cred.keyless,
    source: null,
    storage: null,
    error: null,
  };
}

async function fetchLiveCoverage(projectDir: string): Promise<SemanticIndexStatus | null> {
  try {
    const lock = readServerLock(resolveLockDir(projectDir));
    if (!lock || lock.port <= 0 || !isProcessAlive(lock.pid)) return null;
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/semantic-status`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const parsed = SemanticIndexStatusSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatSemanticCapabilityLabel(
  offered: boolean,
  coverage: SemanticIndexStatus | null,
): string {
  if (!offered) return 'unavailable (search stays lexical)';
  const providerFailure = classifySemanticProviderError(coverage);
  if (providerFailure === 'restart_required') {
    return 'RESTART REQUIRED (provider vector dimensions changed repeatedly)';
  }
  if (providerFailure === 'incapable') {
    return "CONFIGURATION ERROR (remove search.semantic.dimensions to use the model's own size)";
  }
  if (providerFailure === 'provider_error') {
    if (coverage?.providerErrorReason === 'warm') {
      return 'temporarily unavailable (provider initialization failed)';
    }
    if (coverage?.providerErrorReason === 'corpus') {
      return 'partially unavailable (corpus indexing requests failed)';
    }
    if (coverage?.providerErrorReason === 'query') {
      return 'temporarily unavailable (query embedding failed)';
    }
    return 'temporarily unavailable (provider error)';
  }
  return 'AVAILABLE';
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
      const store = createEmbeddingsSecretStore();
      try {
        await store.setForProject(projectDir, baseUrl, key);
      } catch (e) {
        process.stderr.write(
          `Failed to store the embeddings key: ${credentialFailureMessage(e)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `✓ Embeddings API key stored for ${baseUrl}\n` +
          `  (${store.backend === 'keyring' ? 'OS credential store' : `file fallback: ${okUserHomeDisplayPath(OK_USER_HOME_SECRETS_FILE)}, 0600`}; never in the project).\n` +
          `  Enable semantic search with \`${currentCliCommandName()} embeddings enable\`, or in\n` +
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
          `Failed to clear the embeddings key: ${credentialFailureMessage(e)}\n`,
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
      const projects = await createEmbeddingsSecretStore()
        .listProjects()
        .catch(credentialStoreError);
      if (projects instanceof EmbeddingsSecretStoreError) {
        process.stderr.write(`${credentialFailureMessage(projects)}\n`);
        process.exitCode = 1;
        return;
      }
      if (projects.length === 0) {
        process.stderr.write('No project embeddings keys stored.\n');
        return;
      }
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

function migrateKeysCommand(): Command {
  return new Command('migrate-keys')
    .description('Move all saved embeddings keys into the OS credential store')
    .action(async () => {
      const store = createEmbeddingsSecretStore();
      let verified = 0;
      let failed = 0;
      const requireNative = () => {
        if (store.backend !== 'file') return true;
        process.stderr.write(
          'No OS credential store is available. Existing keys remain in the restricted file fallback.\n',
        );
        process.exitCode = 1;
        return false;
      };
      const report = (label: string, error: unknown) => {
        failed += 1;
        process.stderr.write(`${label}: ${credentialFailureMessage(error)}\n`);
      };
      const legacy = await store.getLegacyKey().catch(credentialStoreError);
      if (!requireNative()) return;
      if (legacy instanceof EmbeddingsSecretStoreError) report('Shared OpenAI key', legacy);
      else if (legacy !== null) verified += 1;
      const projects = await store.listProjects().catch(credentialStoreError);
      if (!requireNative()) return;
      if (projects instanceof EmbeddingsSecretStoreError) report('Project key inventory', projects);
      else {
        for (const { projectKey, endpoints } of projects) {
          for (const { endpoint } of endpoints) {
            try {
              if (await store.migrateStoredProject(projectKey, endpoint)) verified += 1;
              else {
                failed += 1;
                process.stderr.write(
                  `${JSON.stringify(projectKey)} / ${JSON.stringify(endpoint)}: Stored scope was not verified; the key may be absent or secure storage unavailable.\n`,
                );
              }
            } catch (error) {
              report(`${JSON.stringify(projectKey)} / ${JSON.stringify(endpoint)}`, error);
            }
          }
        }
      }
      process.stdout.write(
        `Credential scopes verified: ${verified}. Requiring attention: ${failed}.\n`,
      );
      if (failed) process.exitCode = 1;
    });
}

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
            : `Refusing an insecure endpoint: use https:// (http:// is allowed only for loopback endpoints). Got: ${url}\n`,
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

function toggleEnabledCommand(name: 'enable' | 'disable', value: boolean): Command {
  return new Command(name)
    .description(`Turn semantic search ${value ? 'on' : 'off'} for this project (project-local)`)
    .option('--cwd <path>', 'Project directory (defaults to the current directory)')
    .action(async (opts: { cwd?: string }) => {
      const projectDir = resolve(opts.cwd ?? process.cwd());
      const cfg = readSemanticConfig(projectDir);
      const keyPresence = value ? await resolveKeyPresence(projectDir, cfg.baseUrl) : null;
      if (keyPresence?.error) {
        process.stderr.write(`${credentialFailureMessage(keyPresence.error)}\n`);
        process.exitCode = 1;
        return;
      }
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
      if (keyPresence) {
        const { present, notRequired } = keyPresence;
        if (!present && !notRequired) {
          process.stderr.write(
            `  Note: no API key set yet — run \`${currentCliCommandName()} embeddings set-key\`. Until then, search stays lexical.\n`,
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
        storage: keyStorage,
        error: keyError,
      } = await resolveKeyPresence(projectDir, cfg.baseUrl);
      const keyUnavailable = keyError !== null;
      if (keyError) {
        process.stderr.write(`${credentialFailureMessage(keyError)}\n`);
        process.exitCode = 1;
      }
      const offered = isSemanticSearchOffered({
        enabled: cfg.enabled,
        keyPresent: hasKey,
        keyNotRequired,
      });
      const coverage = offered ? await fetchLiveCoverage(projectDir) : null;

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({
            project: projectDir,
            key: {
              present: hasKey,
              notRequired: keyNotRequired,
              source: keySource,
              ...(keyError ? { unavailable: true, error: keyError.code } : {}),
            },
            project_config: {
              enabled: cfg.enabled,
              capable: offered,
              coverage: coverage ? { embedded: coverage.embedded, total: coverage.total } : null,
              provider_error: coverage
                ? {
                    active: coverage.providerError === true,
                    reason: coverage.providerErrorReason ?? null,
                  }
                : null,
              provider: {
                baseUrl: cfg.baseUrl,
                model: cfg.model,
                dimensions: cfg.dimensions ?? null,
              },
              transport: {
                maxBatchSize: cfg.maxBatchSize,
                maxBatchChars: cfg.maxBatchChars,
                docTimeoutMs: cfg.docTimeoutMs,
              },
            },
          })}\n`,
        );
        return;
      }

      const storedLocation =
        keySource === 'env'
          ? `environment (${EMBEDDINGS_API_KEY_ENV})`
          : keyStorage === 'file'
            ? `file fallback: ${okUserHomeDisplayPath(OK_USER_HOME_SECRETS_FILE)}`
            : 'OS credential store';
      const keyLabel = keyUnavailable
        ? 'unavailable (saved key presence is unknown)'
        : hasKey
          ? `set for this endpoint — ${storedLocation}`
          : keyNotRequired
            ? 'not required (loopback endpoint)'
            : 'not set';
      const coverageLabel = !offered
        ? null
        : coverage
          ? `${coverage.embedded} / ${coverage.total} pages embedded`
          : 'server not running — start it to index (or it has not embedded yet)';
      const capabilityLabel = formatSemanticCapabilityLabel(offered, coverage);

      const lines = [
        'Semantic search',
        `  project:     ${projectDir}`,
        '',
        '  This project:',
        `    enabled:    ${cfg.enabled ? 'yes' : 'no'}`,
        `    API key:    ${keyLabel}`,
        `    capability: ${capabilityLabel}`,
        ...(coverageLabel ? [`    coverage:   ${coverageLabel}`] : []),
        `    provider:   ${cfg.baseUrl}`,
        `    model:      ${cfg.model}`,
        `    dimensions: ${cfg.dimensions ?? 'auto (detected from the endpoint)'}`,
        `    batch size: ${cfg.maxBatchSize} chunks maximum per indexing request`,
        `    characters: ${cfg.maxBatchChars} approximate characters per indexing request`,
        `    timeout:    ${cfg.docTimeoutMs} ms per indexing request attempt`,
      ];

      const hints: string[] = [];
      if (!hasKey && !keyNotRequired && !keyUnavailable) {
        hints.push(
          `Set a key:  ${currentCliCommandName()} embeddings set-key   (or export ${EMBEDDINGS_API_KEY_ENV})`,
        );
      }
      if (!cfg.enabled) {
        hints.push(
          `Enable it:  ${currentCliCommandName()} embeddings enable   (in this project folder)`,
        );
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
    .addCommand(setUrlCommand())
    .addCommand(clearUrlCommand())
    .addCommand(setModelCommand())
    .addCommand(clearModelCommand())
    .addCommand(toggleEnabledCommand('enable', true))
    .addCommand(toggleEnabledCommand('disable', false))
    .addCommand(listCommand())
    .addCommand(migrateKeysCommand())
    .addCommand(statusCommand());
}
