import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [resultDirectory, packageDirectory, ...command] = process.argv.slice(2);
if (!resultDirectory || !packageDirectory || command.length === 0)
  throw new Error('fixture launch requires results, cwd, and node arguments');
const resultDir = resolve(resultDirectory);
mkdirSync(resultDir, { recursive: true });
const owner = fork(new URL('./shadow-fixture-owner.test-helper.mjs', import.meta.url), [], {
  execArgv: [],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
writeFileSync(
  resolve(resultDir, 'launcher.json'),
  `${JSON.stringify({ pid: process.pid, ownerPid: owner.pid, node: process.version, cwd: process.cwd(), command, packageDirectory: resolve(packageDirectory) })}\n`,
);
owner.on('message', (message) => {
  if (message.type === 'cleaned')
    process.stdout.write(
      `${JSON.stringify({ ownerCleanup: message.receipt.reason, nativeRunnerExit: message.receipt.runnerExit, normalResidue: message.receipt.normalResidue })}\n`,
    );
});
owner.once('exit', (code, signal) => {
  const path = resolve(resultDir, 'cleanup.json');
  const receipt = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  writeFileSync(
    resolve(resultDir, 'launcher-exit.json'),
    `${JSON.stringify({ ownerExit: { code, signal }, runnerExit: receipt?.runnerExit, workDirAbsent: receipt?.workDirAbsent })}\n`,
  );
  process.exitCode =
    code !== 0 || !receipt?.workDirAbsent || (receipt.normalResidue?.length ?? 0) > 0
      ? 1
      : (receipt.runnerExit?.code ?? 1);
});
owner.send({
  type: 'start',
  config: {
    resultDir,
    cwd: resolve(packageDirectory),
    args: command,
    scratchRoot: process.env.OK_SHADOW_SCRATCH_ROOT,
    maxLifetimeMs: Number(process.env.OK_SHADOW_MAX_LIFETIME_MS ?? 540_000),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (owner.connected) owner.send({ type: 'release' });
  });
}
if (process.argv[1] !== fileURLToPath(import.meta.url))
  throw new Error('fixture launch must run as its entrypoint');
