/**
 * Worker-thread entry for the bundled CLI. The published package (and the
 * packaged desktop app, which spawns dist/cli.mjs) ships no node_modules,
 * so the parse pool's sibling probe (`./parse-worker.mjs` next to the
 * importing bundle) is the only resolution path — this file exists solely
 * to make tsdown emit that sibling. All logic lives in the server package;
 * see `packages/server/src/parse-worker.ts`.
 */
import '@inkeep/open-knowledge-server/parse-worker';
