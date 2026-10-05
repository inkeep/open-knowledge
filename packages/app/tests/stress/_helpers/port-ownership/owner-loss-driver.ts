import { runOwnershipCase } from './run-case.test-helper.ts';

const runDir = process.argv[2];
if (!runDir) throw new Error('owner-loss driver needs a run directory');

process.on('message', (message) => {
  if (message === 'exit') process.exit(0);
});
process.on('disconnect', () => process.exit(0));

setTimeout(() => process.exit(5), 20_000);

void runOwnershipCase({
  file: 'tests/stress/_helpers/port-ownership/lifetime.ownership-case.ts',
  name: 'nested lifetime control reaches its test body',
  caller: 'lifetime-owner-loss',
  runDir,
}).then(
  () => process.exit(3),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(4);
  },
);
