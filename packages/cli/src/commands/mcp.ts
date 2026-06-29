
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Config } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import {
  emitBundleProxyEvent,
  findBundledOkPath,
  proxyToBundle,
  shouldProxyToBundle,
} from '../mcp/bundle-proxy.ts';
import { startGlobalMcpServer } from '../mcp/server.ts';
import { parseSpawnTimeoutEnv, startMcpShim } from '../mcp/shim.ts';

export function mcpCommand(getConfig: () => Config): Command {
  const cmd = new Command('mcp')
    .description('Start MCP stdio server for project knowledge base')
    .option(
      '-p, --port <port>',
      'Override per-call routing and proxy stdio to this HTTP MCP port (skips bundle proxy)',
      undefined,
    )
    .option(
      '--no-bundle-proxy',
      'Run the npm-fetched MCP server in-process instead of proxying to the macOS Desktop bundle (equivalent: OK_BUNDLE_PROXY=0)',
    )
    .action(async (opts: { port?: string; bundleProxy?: boolean }) => {
      try {
        const startupConfig = getConfig();
        const startupCwd = process.cwd();

        if (opts.port !== undefined) {
          const timeoutMs = parseSpawnTimeoutEnv(process.env.OK_MCP_SPAWN_TIMEOUT_MS);
          await startMcpShim({
            lockDir: '',
            contentDir: '',
            portOverride: opts.port,
            envAutoStart: process.env.OK_MCP_AUTOSTART,
            timeoutMs,
          });
          return;
        }

        const argvForDecision =
          opts.bundleProxy === false ? [...process.argv, '--no-bundle-proxy'] : process.argv;
        const decision = shouldProxyToBundle(process.env, argvForDecision, process.platform);
        if (!decision.proxy) {
          const mode =
            decision.suppressedBy === 'env'
              ? 'suppressed-env'
              : decision.suppressedBy === 'flag'
                ? 'suppressed-flag'
                : decision.suppressedBy === 'self'
                  ? 'suppressed-self'
                  : 'suppressed-platform';
          emitBundleProxyEvent({ stderr: process.stderr, mode, bundlePath: null, reason: null });
        } else {
          const bundlePath = findBundledOkPath(process.platform, homedir(), { existsSync });
          if (bundlePath === null) {
            emitBundleProxyEvent({
              stderr: process.stderr,
              mode: 'fallback-absent',
              bundlePath: null,
              reason: 'no installed OpenKnowledge.app bundle found',
            });
          } else {
            try {
              await proxyToBundle({
                bundlePath,
                argv: process.argv.slice(2),
                env: process.env,
                stderr: process.stderr,
              });
              return;
            } catch (err) {
              emitBundleProxyEvent({
                stderr: process.stderr,
                mode: 'fallback-exec-failed',
                bundlePath,
                reason: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        await startGlobalMcpServer({
          startupCwd,
          startupConfig,
        });
      } catch (err) {
        process.stderr.write(
          `MCP server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  return cmd;
}
