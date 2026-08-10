import { describe, expect, test } from 'vitest';
import {
  classifyDownloadOs,
  type DetectedOs,
  DOWNLOAD_TARGETS,
  defaultTargetForOs,
  downloadHrefForTarget,
  downloadLabelForOs,
  orderTargetsForOs,
  resolveTargetFromParams,
  targetQuery,
} from './download-targets.ts';

const ALL_OS: readonly DetectedOs[] = ['macos', 'windows', 'linux', 'unknown'];
const ASSET_PREFIX = 'https://github.com/inkeep/open-knowledge/releases/latest/download/';

describe('DOWNLOAD_TARGETS', () => {
  test('ids are unique — they are the analytics discriminator', () => {
    const ids = DOWNLOAD_TARGETS.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('no two builds share an asset URL', () => {
    const urls = DOWNLOAD_TARGETS.map((target) => target.assetUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test('every asset is a version-less `releases/latest` alias', () => {
    for (const target of DOWNLOAD_TARGETS) {
      expect(target.assetUrl.startsWith(ASSET_PREFIX)).toBe(true);
    }
  });

  test('the os/arch/format triple identifies exactly one build', () => {
    const triples = DOWNLOAD_TARGETS.map(targetQuery);
    expect(new Set(triples).size).toBe(triples.length);
  });

  test('macOS ships Apple Silicon only — an Intel entry would 404', () => {
    const mac = DOWNLOAD_TARGETS.filter((target) => target.os === 'macos');
    expect(mac).toHaveLength(1);
    expect(mac[0]?.arch).toBe('arm64');
  });
});

describe('defaultTargetForOs', () => {
  test('guesses the common arch per OS', () => {
    expect(defaultTargetForOs('macos').id).toBe('macos-arm64');
    expect(defaultTargetForOs('windows').id).toBe('windows-x64');
    expect(defaultTargetForOs('linux').id).toBe('linux-deb-x64');
  });

  test('an undetected visitor gets the macOS floor, never nothing', () => {
    expect(defaultTargetForOs('unknown').id).toBe('macos-arm64');
  });

  test('the default for an OS is actually a build for that OS', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      expect(defaultTargetForOs(os).os).toBe(os);
    }
  });
});

describe('orderTargetsForOs', () => {
  test('hoists the detected OS without dropping or duplicating a build', () => {
    for (const os of ALL_OS) {
      const ordered = orderTargetsForOs(os);
      expect(ordered).toHaveLength(DOWNLOAD_TARGETS.length);
      expect(new Set(ordered.map((t) => t.id))).toEqual(new Set(DOWNLOAD_TARGETS.map((t) => t.id)));
    }
  });

  test('the detected OS leads the list', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      expect(orderTargetsForOs(os)[0]?.os).toBe(os);
    }
  });
});

describe('downloadLabelForOs', () => {
  test('stays neutral until an OS is known, so it is never wrong', () => {
    expect(downloadLabelForOs('unknown')).toBe('Download');
  });

  test('names the detected OS once it is known', () => {
    expect(downloadLabelForOs('windows')).toBe('Download for Windows');
  });
});

describe('downloadHrefForTarget', () => {
  test('routes through the tracked redirect carrying both the CTA and the build', () => {
    const href = downloadHrefForTarget('docs-sidebar', defaultTargetForOs('linux'));
    expect(href).toBe('/download/stable?utm_content=docs-sidebar&os=linux&arch=x64&format=deb');
  });

  test('never links a GitHub asset directly — that would lose the download event', () => {
    for (const target of DOWNLOAD_TARGETS) {
      expect(downloadHrefForTarget('docs-content', target).startsWith('/download/stable?')).toBe(
        true,
      );
    }
  });
});

describe('resolveTargetFromParams', () => {
  test('round-trips every build through its own query', () => {
    for (const target of DOWNLOAD_TARGETS) {
      const resolved = resolveTargetFromParams(new URLSearchParams(targetQuery(target)));
      expect(resolved?.id).toBe(target.id);
    }
  });

  test('a bare ?os= resolves to that OS default rather than failing', () => {
    expect(resolveTargetFromParams(new URLSearchParams('os=windows'))?.id).toBe('windows-x64');
    expect(resolveTargetFromParams(new URLSearchParams('os=linux'))?.id).toBe('linux-deb-x64');
  });

  test('no params means no opinion — the caller applies its own fallback', () => {
    expect(resolveTargetFromParams(new URLSearchParams(''))).toBeNull();
  });

  test('an unknown OS resolves to nothing rather than a wrong-platform installer', () => {
    expect(resolveTargetFromParams(new URLSearchParams('os=solaris&arch=sparc'))).toBeNull();
  });

  test('an unbuilt arch for a known OS falls back to that OS, not to macOS', () => {
    const resolved = resolveTargetFromParams(new URLSearchParams('os=linux&arch=riscv'));
    expect(resolved?.os).toBe('linux');
  });
});

describe('classifyDownloadOs', () => {
  test('reads the narrow userAgentData platform values', () => {
    expect(classifyDownloadOs('macOS')).toBe('macos');
    expect(classifyDownloadOs('Windows')).toBe('windows');
    expect(classifyDownloadOs('Linux')).toBe('linux');
  });

  test('mobile falls through to unknown — it cannot run the desktop app', () => {
    expect(classifyDownloadOs('iOS')).toBe('unknown');
    expect(classifyDownloadOs('Android')).toBe('unknown');
  });

  test('missing input is unknown, not a guess', () => {
    expect(classifyDownloadOs(null)).toBe('unknown');
    expect(classifyDownloadOs('')).toBe('unknown');
  });
});
