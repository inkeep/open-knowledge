import { describe, expect, test } from 'vitest';
import {
  pathShimBinDir,
  pathShimBlockLabel,
  pathShimFishConfFileName,
  pathShimHomeDirName,
  pathShimMarkerPath,
} from './path-shim-layout.ts';

describe('path shim layout', () => {
  test('Stable keeps its historical names and paths', () => {
    expect(pathShimHomeDirName('stable')).toBe('.ok');
    expect(pathShimBinDir('stable', '/Users/a/')).toBe('/Users/a/.ok/bin');
    expect(pathShimMarkerPath('stable', '/Users/a')).toBe(
      '/Users/a/Library/Application Support/OpenKnowledge/path-install.json',
    );
    expect(pathShimBlockLabel('stable')).toBe('open-knowledge cli');
    expect(pathShimFishConfFileName('stable')).toBe('open-knowledge.fish');
  });

  test('Beta lives under ~/.ok-beta with its own block and fish file', () => {
    expect(pathShimHomeDirName('beta')).toBe('.ok-beta');
    expect(pathShimBinDir('beta', '/Users/a')).toBe('/Users/a/.ok-beta/bin');
    expect(pathShimMarkerPath('beta', '/Users/a')).toBe('/Users/a/.ok-beta/path-install.json');
    expect(pathShimBlockLabel('beta')).toBe('open-knowledge beta cli');
    expect(pathShimFishConfFileName('beta')).toBe('open-knowledge-beta.fish');
  });
});
