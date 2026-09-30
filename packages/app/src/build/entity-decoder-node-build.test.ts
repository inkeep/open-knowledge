import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENTITY_DECODER_ID, resolveEntityDecoderNodeBuild } from './entity-decoder-node-build';

const appDir = new URL('../..', import.meta.url).pathname;

describe('resolveEntityDecoderNodeBuild', () => {
  it('finds a build of the entity decoder that never touches the DOM', () => {
    const nodeBuild = resolveEntityDecoderNodeBuild(appDir);
    expect(nodeBuild).not.toBeNull();
    if (nodeBuild === null) return;
    expect(nodeBuild.endsWith(`${ENTITY_DECODER_ID}/index.js`)).toBe(true);
    expect(readFileSync(nodeBuild, 'utf8')).not.toContain('document');
  });

  it('never answers with the DOM build, whatever directory it is asked about', () => {
    for (const dir of [appDir, '/nonexistent/app/dir']) {
      const nodeBuild = resolveEntityDecoderNodeBuild(dir);
      expect(nodeBuild === null || nodeBuild.endsWith('/index.js'), dir).toBe(true);
      expect(nodeBuild?.endsWith('index.dom.js') ?? false, dir).toBe(false);
    }
  });
});
