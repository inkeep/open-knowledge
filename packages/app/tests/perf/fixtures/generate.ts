import { writeSyntheticFixtures } from './synthetic-doc.ts';

const force = process.argv.includes('--force');

for (const result of writeSyntheticFixtures({ force })) {
  const state = result.written ? `wrote ${result.bytes} bytes` : 'already present, kept';
  console.log(`${result.path}: ${state}`);
}
