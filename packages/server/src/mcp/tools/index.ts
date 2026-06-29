
import type { AgentIdentity } from '../agent-identity.ts';
import { getCurrentMcpLogger, type McpLogger } from '../logger.ts';
import { createLoggedServer } from '../tool-logging.ts';
import { register as registerCheckpoint } from './checkpoint.ts';
import { register as registerConfig } from './config.ts';
import { register as registerConflicts } from './conflicts.ts';
import { register as registerDelete } from './delete.ts';
import { register as registerEdit } from './edit.ts';
import { register as registerExec } from './exec.ts';
import { register as registerPreviewUrl } from './get-preview-url.ts';
import { register as registerHistory } from './history.ts';
import { register as registerInstall } from './install.ts';
import { register as registerLinks } from './links.ts';
import { register as registerMove } from './move.ts';
import { register as registerPalette } from './palette.ts';
import { register as registerResolveConflict } from './resolve-conflict.ts';
import { register as registerRestoreVersion } from './restore-version.ts';
import { register as registerSearch } from './search.ts';
import { register as registerShareLink } from './share-link.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import { register as registerSkills } from './skills.ts';
import { register as registerWorkflow } from './workflow.ts';
import { register as registerWrite } from './write.ts';

type ResolveCwd = (explicit?: string) => Promise<string>;

interface RegisterAllToolsOptions {
  serverUrl?: ServerUrlOrResolver;
  resolveCwd: ResolveCwd;
  config: ConfigOrResolver;
  identityRef?: { current: AgentIdentity };
  logger?: McpLogger;
}

export function registerAllTools(server: ServerInstance, opts: RegisterAllToolsOptions): void {
  const log = opts.logger;
  const registrationServer = createLoggedServer(server, {
    logger: opts.logger,
    identityRef: opts.identityRef,
  });
  const named =
    (tool: string): ResolveCwd =>
    async (explicit?: string) => {
      try {
        const cwd = await opts.resolveCwd(explicit);
        const activeLog = getCurrentMcpLogger() ?? log;
        activeLog?.debug('tool cwd resolved', { tool, cwd, ...(explicit ? { explicit } : {}) });
        return cwd;
      } catch (err) {
        const activeLog = getCurrentMcpLogger() ?? log;
        activeLog?.warn('tool call failed', {
          tool,
          error: err instanceof Error ? err.message : String(err),
          ...(explicit ? { explicit } : {}),
        });
        throw err;
      }
    };

  registerExec(registrationServer, {
    resolveCwd: named('exec'),
    serverUrl: opts.serverUrl,
    config: opts.config,
  });

  registerWorkflow(registrationServer, { config: opts.config, resolveCwd: named('workflow') });

  registerSearch(registrationServer, {
    resolveCwd: named('search'),
    config: opts.config,
    serverUrl: opts.serverUrl,
  });
  registerLinks(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('links'),
  });

  registerWrite(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('write'),
    identityRef: opts.identityRef,
  });
  registerEdit(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('edit'),
    identityRef: opts.identityRef,
  });
  registerDelete(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('delete'),
    identityRef: opts.identityRef,
  });
  registerMove(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('move'),
    identityRef: opts.identityRef,
  });
  registerInstall(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('install'),
    identityRef: opts.identityRef,
  });
  registerHistory(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('history'),
  });
  registerSkills(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('skills'),
  });
  registerCheckpoint(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('checkpoint'),
    identityRef: opts.identityRef,
  });
  registerRestoreVersion(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('restore_version'),
    identityRef: opts.identityRef,
  });
  registerPalette(registrationServer, {
    resolveCwd: named('palette'),
    config: opts.config,
  });

  registerConfig(registrationServer, {
    config: opts.config,
    resolveCwd: named('config'),
  });
  registerPreviewUrl(registrationServer, {
    config: opts.config,
    resolveCwd: named('preview_url'),
    serverUrl: opts.serverUrl,
  });
  registerConflicts(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('conflicts'),
  });
  registerResolveConflict(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('resolve_conflict'),
  });

  registerShareLink(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('share_link'),
  });
}
