import { watchCliOwner } from './cli-owner.test-helper.ts';

watchCliOwner(process, () => {
  process.stderr.write(`CLI child owner disconnected: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(1);
});
