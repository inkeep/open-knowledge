import { describe, expect, test } from 'bun:test';
import type { Node as PmNode } from '@tiptap/pm/model';
import { builtInComponents } from './index.ts';
import type { CompatMeta } from './types.ts';

function makeMockNode(componentName: string, props: Record<string, unknown>): PmNode {
  return {
    attrs: { props, componentName },
  } as unknown as PmNode;
}

const wikiEmbedImage = builtInComponents.find(
  (m): m is CompatMeta => m.surface === 'compat' && m.name === 'WikiEmbedImage',
);
const wikiEmbedVideo = builtInComponents.find(
  (m): m is CompatMeta => m.surface === 'compat' && m.name === 'WikiEmbedVideo',
);
const wikiEmbedAudio = builtInComponents.find(
  (m): m is CompatMeta => m.surface === 'compat' && m.name === 'WikiEmbedAudio',
);
const wikiEmbedFile = builtInComponents.find(
  (m): m is CompatMeta => m.surface === 'compat' && m.name === 'WikiEmbedFile',
);

describe('WikiEmbedImage descriptor — registration', () => {
  test('is registered in builtInComponents as a compat descriptor', () => {
    expect(wikiEmbedImage).toBeDefined();
    expect(wikiEmbedImage?.surface).toBe('compat');
  });

  test('rendersAs the canonical `img`', () => {
    expect(wikiEmbedImage?.rendersAs).toBe('img');
  });

  test('declares hasChildren=false and isSelfClosing=true (matches img)', () => {
    expect(wikiEmbedImage?.hasChildren).toBe(false);
    expect(wikiEmbedImage?.isSelfClosing).toBe(true);
  });

  test('exposes exactly one editable prop (alias)', () => {
    expect(wikiEmbedImage?.props.length).toBe(1);
    expect(wikiEmbedImage?.props[0]?.name).toBe('alias');
    expect(wikiEmbedImage?.props[0]?.type).toBe('string');
    expect(wikiEmbedImage?.props[0]?.required).toBe(false);
  });
});

describe('WikiEmbedImage.translateProps — render-time prop translation', () => {
  test('alias non-empty → alt = alias', () => {
    if (!wikiEmbedImage) throw new Error('descriptor missing');
    const out = wikiEmbedImage.translateProps({
      src: '/photo.png',
      target: 'photo.png',
      alias: 'a cute cat',
      anchor: null,
    });
    expect(out.src).toBe('/photo.png');
    expect(out.alt).toBe('a cute cat');
  });

  test('alias empty string → alt = target (filename fallback)', () => {
    if (!wikiEmbedImage) throw new Error('descriptor missing');
    const out = wikiEmbedImage.translateProps({
      src: '/photo.png',
      target: 'photo.png',
      alias: '',
      anchor: null,
    });
    expect(out.alt).toBe('photo.png');
  });

  test('alias missing → alt = target', () => {
    if (!wikiEmbedImage) throw new Error('descriptor missing');
    const out = wikiEmbedImage.translateProps({
      src: '/photo.png',
      target: 'photo.png',
    });
    expect(out.alt).toBe('photo.png');
  });

  test('alias is non-string (null) → alt = target', () => {
    if (!wikiEmbedImage) throw new Error('descriptor missing');
    const out = wikiEmbedImage.translateProps({
      src: '/photo.png',
      target: 'photo.png',
      alias: null,
    });
    expect(out.alt).toBe('photo.png');
  });
});

describe('WikiEmbedImage.serialize — source-form mdast emit', () => {
  function callSerialize(node: PmNode) {
    if (!wikiEmbedImage) throw new Error('descriptor missing');
    return wikiEmbedImage.serialize(node, {
      all: () => [],
      registry: { getOrWildcard: () => wikiEmbedImage },
      serializeChildren: () => '',
    });
  }

  test('plain target (no alias, no anchor) → wikiLinkEmbed with target as label', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedImage', { src: '/photo.png', target: 'photo.png' }),
    );
    const cast = out as unknown as {
      type: string;
      value: string;
      data: { target: string; anchor: string | null; alias: string | null };
      children: Array<{ type: string; value: string }>;
    };
    expect(cast.type).toBe('wikiLinkEmbed');
    expect(cast.value).toBe('photo.png');
    expect(cast.data.target).toBe('photo.png');
    expect(cast.data.anchor).toBeNull();
    expect(cast.data.alias).toBeNull();
    expect(cast.children).toEqual([{ type: 'text', value: 'photo.png' }]);
  });

  test('alias set → label uses alias', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedImage', {
        src: '/photo.png',
        target: 'photo.png',
        alias: 'caption',
        anchor: null,
      }),
    );
    const cast = out as unknown as { value: string; data: { alias: string | null } };
    expect(cast.value).toBe('caption');
    expect(cast.data.alias).toBe('caption');
  });

  test('anchor set, no alias → label is target#anchor', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedImage', {
        src: '/photo.png',
        target: 'photo.png',
        alias: null,
        anchor: 'frag',
      }),
    );
    const cast = out as unknown as {
      value: string;
      data: { target: string; anchor: string | null };
    };
    expect(cast.value).toBe('photo.png#frag');
    expect(cast.data.anchor).toBe('frag');
  });

  test('alias + anchor present → alias wins for label, anchor preserved in data', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedImage', {
        src: '/photo.png',
        target: 'photo.png',
        alias: 'caption',
        anchor: 'frag',
      }),
    );
    const cast = out as unknown as {
      value: string;
      data: { alias: string | null; anchor: string | null };
    };
    expect(cast.value).toBe('caption');
    expect(cast.data.alias).toBe('caption');
    expect(cast.data.anchor).toBe('frag');
  });

  test('empty alias string → falls back to target as label (alias treated as absent)', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedImage', {
        src: '/photo.png',
        target: 'photo.png',
        alias: '',
        anchor: null,
      }),
    );
    const cast = out as unknown as { value: string };
    expect(cast.value).toBe('photo.png');
  });

  test('missing target → empty label (defensive — parser always supplies one)', () => {
    const out = callSerialize(makeMockNode('WikiEmbedImage', { src: '/photo.png' }));
    const cast = out as unknown as {
      value: string;
      data: { target: string };
    };
    expect(cast.value).toBe('');
    expect(cast.data.target).toBe('');
  });
});


describe('WikiEmbedVideo descriptor — registration', () => {
  test('is registered in builtInComponents as a compat descriptor', () => {
    expect(wikiEmbedVideo).toBeDefined();
    expect(wikiEmbedVideo?.surface).toBe('compat');
  });

  test('rendersAs the canonical `video`', () => {
    expect(wikiEmbedVideo?.rendersAs).toBe('video');
  });

  test('declares hasChildren=false and isSelfClosing=true (matches video)', () => {
    expect(wikiEmbedVideo?.hasChildren).toBe(false);
    expect(wikiEmbedVideo?.isSelfClosing).toBe(true);
  });

  test('exposes exactly one editable prop (alias)', () => {
    expect(wikiEmbedVideo?.props.length).toBe(1);
    expect(wikiEmbedVideo?.props[0]?.name).toBe('alias');
    expect(wikiEmbedVideo?.props[0]?.type).toBe('string');
    expect(wikiEmbedVideo?.props[0]?.required).toBe(false);
  });
});

describe('WikiEmbedVideo.translateProps — render-time prop translation', () => {
  test('alias non-empty → title = alias', () => {
    if (!wikiEmbedVideo) throw new Error('descriptor missing');
    const out = wikiEmbedVideo.translateProps({
      src: '/clip.mp4',
      target: 'clip.mp4',
      alias: 'demo recording',
      anchor: null,
    });
    expect(out.src).toBe('/clip.mp4');
    expect(out.title).toBe('demo recording');
  });

  test('alias empty string → title = target (filename fallback)', () => {
    if (!wikiEmbedVideo) throw new Error('descriptor missing');
    const out = wikiEmbedVideo.translateProps({
      src: '/clip.mp4',
      target: 'clip.mp4',
      alias: '',
      anchor: null,
    });
    expect(out.title).toBe('clip.mp4');
  });

  test('alias missing → title = target', () => {
    if (!wikiEmbedVideo) throw new Error('descriptor missing');
    const out = wikiEmbedVideo.translateProps({
      src: '/clip.mp4',
      target: 'clip.mp4',
    });
    expect(out.title).toBe('clip.mp4');
  });

  test('alias is non-string (null) → title = target', () => {
    if (!wikiEmbedVideo) throw new Error('descriptor missing');
    const out = wikiEmbedVideo.translateProps({
      src: '/clip.mp4',
      target: 'clip.mp4',
      alias: null,
    });
    expect(out.title).toBe('clip.mp4');
  });

  test('does NOT emit an `alt` prop (video canonical has no alt slot)', () => {
    if (!wikiEmbedVideo) throw new Error('descriptor missing');
    const out = wikiEmbedVideo.translateProps({
      src: '/clip.mp4',
      target: 'clip.mp4',
      alias: 'demo',
    });
    expect(out.alt).toBeUndefined();
  });
});

describe('WikiEmbedVideo.serialize — source-form mdast emit', () => {
  function callSerialize(node: PmNode) {
    if (!wikiEmbedVideo) throw new Error('descriptor missing');
    return wikiEmbedVideo.serialize(node, {
      all: () => [],
      registry: { getOrWildcard: () => wikiEmbedVideo },
      serializeChildren: () => '',
    });
  }

  test('plain target (no alias, no anchor) → wikiLinkEmbed with target as label', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedVideo', { src: '/clip.mp4', target: 'clip.mp4' }),
    );
    const cast = out as unknown as {
      type: string;
      value: string;
      data: { target: string; anchor: string | null; alias: string | null };
      children: Array<{ type: string; value: string }>;
    };
    expect(cast.type).toBe('wikiLinkEmbed');
    expect(cast.value).toBe('clip.mp4');
    expect(cast.data.target).toBe('clip.mp4');
    expect(cast.data.anchor).toBeNull();
    expect(cast.data.alias).toBeNull();
    expect(cast.children).toEqual([{ type: 'text', value: 'clip.mp4' }]);
  });

  test('alias set → label uses alias', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedVideo', {
        src: '/clip.mp4',
        target: 'clip.mp4',
        alias: 'demo recording',
        anchor: null,
      }),
    );
    const cast = out as unknown as { value: string; data: { alias: string | null } };
    expect(cast.value).toBe('demo recording');
    expect(cast.data.alias).toBe('demo recording');
  });

  test('anchor set, no alias → label is target#anchor', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedVideo', {
        src: '/clip.mp4',
        target: 'clip.mp4',
        alias: null,
        anchor: 't=42',
      }),
    );
    const cast = out as unknown as {
      value: string;
      data: { target: string; anchor: string | null };
    };
    expect(cast.value).toBe('clip.mp4#t=42');
    expect(cast.data.anchor).toBe('t=42');
  });

  test('alias + anchor present → alias wins for label, anchor preserved in data', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedVideo', {
        src: '/clip.mp4',
        target: 'clip.mp4',
        alias: 'demo',
        anchor: 't=42',
      }),
    );
    const cast = out as unknown as {
      value: string;
      data: { alias: string | null; anchor: string | null };
    };
    expect(cast.value).toBe('demo');
    expect(cast.data.alias).toBe('demo');
    expect(cast.data.anchor).toBe('t=42');
  });

  test('empty alias string → falls back to target as label (alias treated as absent)', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedVideo', {
        src: '/clip.mp4',
        target: 'clip.mp4',
        alias: '',
        anchor: null,
      }),
    );
    const cast = out as unknown as { value: string };
    expect(cast.value).toBe('clip.mp4');
  });

  test('missing target → empty label (defensive — parser always supplies one)', () => {
    const out = callSerialize(makeMockNode('WikiEmbedVideo', { src: '/clip.mp4' }));
    const cast = out as unknown as {
      value: string;
      data: { target: string };
    };
    expect(cast.value).toBe('');
    expect(cast.data.target).toBe('');
  });
});


describe('WikiEmbedAudio descriptor — registration', () => {
  test('is registered in builtInComponents as a compat descriptor', () => {
    expect(wikiEmbedAudio).toBeDefined();
    expect(wikiEmbedAudio?.surface).toBe('compat');
  });

  test('rendersAs the canonical `audio`', () => {
    expect(wikiEmbedAudio?.rendersAs).toBe('audio');
  });

  test('declares hasChildren=false and isSelfClosing=true (matches audio)', () => {
    expect(wikiEmbedAudio?.hasChildren).toBe(false);
    expect(wikiEmbedAudio?.isSelfClosing).toBe(true);
  });

  test('exposes exactly one editable prop (alias)', () => {
    expect(wikiEmbedAudio?.props.length).toBe(1);
    expect(wikiEmbedAudio?.props[0]?.name).toBe('alias');
    expect(wikiEmbedAudio?.props[0]?.type).toBe('string');
    expect(wikiEmbedAudio?.props[0]?.required).toBe(false);
  });
});

describe('WikiEmbedAudio.translateProps — render-time prop translation', () => {
  test('alias non-empty → title = alias', () => {
    if (!wikiEmbedAudio) throw new Error('descriptor missing');
    const out = wikiEmbedAudio.translateProps({
      src: '/song.mp3',
      target: 'song.mp3',
      alias: 'theme song',
      anchor: null,
    });
    expect(out.src).toBe('/song.mp3');
    expect(out.title).toBe('theme song');
  });

  test('alias empty string → title = target (filename fallback)', () => {
    if (!wikiEmbedAudio) throw new Error('descriptor missing');
    const out = wikiEmbedAudio.translateProps({
      src: '/song.mp3',
      target: 'song.mp3',
      alias: '',
      anchor: null,
    });
    expect(out.title).toBe('song.mp3');
  });

  test('alias missing → title = target', () => {
    if (!wikiEmbedAudio) throw new Error('descriptor missing');
    const out = wikiEmbedAudio.translateProps({
      src: '/song.mp3',
      target: 'song.mp3',
    });
    expect(out.title).toBe('song.mp3');
  });

  test('alias is non-string (null) → title = target', () => {
    if (!wikiEmbedAudio) throw new Error('descriptor missing');
    const out = wikiEmbedAudio.translateProps({
      src: '/song.mp3',
      target: 'song.mp3',
      alias: null,
    });
    expect(out.title).toBe('song.mp3');
  });

  test('does NOT emit an `alt` prop (audio canonical has no alt slot)', () => {
    if (!wikiEmbedAudio) throw new Error('descriptor missing');
    const out = wikiEmbedAudio.translateProps({
      src: '/song.mp3',
      target: 'song.mp3',
      alias: 'theme',
    });
    expect(out.alt).toBeUndefined();
  });
});

describe('WikiEmbedAudio.serialize — source-form mdast emit', () => {
  function callSerialize(node: PmNode) {
    if (!wikiEmbedAudio) throw new Error('descriptor missing');
    return wikiEmbedAudio.serialize(node, {
      all: () => [],
      registry: { getOrWildcard: () => wikiEmbedAudio },
      serializeChildren: () => '',
    });
  }

  test('plain target (no alias, no anchor) → wikiLinkEmbed with target as label', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedAudio', { src: '/song.mp3', target: 'song.mp3' }),
    );
    const cast = out as unknown as {
      type: string;
      value: string;
      data: { target: string; anchor: string | null; alias: string | null };
      children: Array<{ type: string; value: string }>;
    };
    expect(cast.type).toBe('wikiLinkEmbed');
    expect(cast.value).toBe('song.mp3');
    expect(cast.data.target).toBe('song.mp3');
    expect(cast.data.anchor).toBeNull();
    expect(cast.data.alias).toBeNull();
    expect(cast.children).toEqual([{ type: 'text', value: 'song.mp3' }]);
  });

  test('alias set → label uses alias', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedAudio', {
        src: '/song.mp3',
        target: 'song.mp3',
        alias: 'theme song',
        anchor: null,
      }),
    );
    const cast = out as unknown as { value: string; data: { alias: string | null } };
    expect(cast.value).toBe('theme song');
    expect(cast.data.alias).toBe('theme song');
  });

  test('anchor set, no alias → label is target#anchor', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedAudio', {
        src: '/song.mp3',
        target: 'song.mp3',
        alias: null,
        anchor: 't=10',
      }),
    );
    const cast = out as unknown as {
      value: string;
      data: { target: string; anchor: string | null };
    };
    expect(cast.value).toBe('song.mp3#t=10');
    expect(cast.data.anchor).toBe('t=10');
  });

  test('alias + anchor present → alias wins for label, anchor preserved in data', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedAudio', {
        src: '/song.mp3',
        target: 'song.mp3',
        alias: 'theme',
        anchor: 't=10',
      }),
    );
    const cast = out as unknown as {
      value: string;
      data: { alias: string | null; anchor: string | null };
    };
    expect(cast.value).toBe('theme');
    expect(cast.data.alias).toBe('theme');
    expect(cast.data.anchor).toBe('t=10');
  });

  test('empty alias string → falls back to target as label (alias treated as absent)', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedAudio', {
        src: '/song.mp3',
        target: 'song.mp3',
        alias: '',
        anchor: null,
      }),
    );
    const cast = out as unknown as { value: string };
    expect(cast.value).toBe('song.mp3');
  });

  test('missing target → empty label (defensive — parser always supplies one)', () => {
    const out = callSerialize(makeMockNode('WikiEmbedAudio', { src: '/song.mp3' }));
    const cast = out as unknown as {
      value: string;
      data: { target: string };
    };
    expect(cast.value).toBe('');
    expect(cast.data.target).toBe('');
  });
});


describe('WikiEmbedFile descriptor — registration', () => {
  test('is registered in builtInComponents as a compat descriptor', () => {
    expect(wikiEmbedFile).toBeDefined();
    expect(wikiEmbedFile?.surface).toBe('compat');
  });

  test('rendersAs the canonical `File`', () => {
    expect(wikiEmbedFile?.rendersAs).toBe('File');
  });

  test('declares hasChildren=false and isSelfClosing=true (matches File)', () => {
    expect(wikiEmbedFile?.hasChildren).toBe(false);
    expect(wikiEmbedFile?.isSelfClosing).toBe(true);
  });

  test('exposes exactly one editable prop (alias)', () => {
    expect(wikiEmbedFile?.props.length).toBe(1);
    expect(wikiEmbedFile?.props[0]?.name).toBe('alias');
    expect(wikiEmbedFile?.props[0]?.type).toBe('string');
    expect(wikiEmbedFile?.props[0]?.required).toBe(false);
  });
});

describe('WikiEmbedFile.translateProps — render-time prop translation', () => {
  test('alias non-empty → name = alias', () => {
    if (!wikiEmbedFile) throw new Error('descriptor missing');
    const out = wikiEmbedFile.translateProps({
      src: '/handbook.docx',
      target: 'handbook.docx',
      alias: 'Team Handbook',
    });
    expect(out.src).toBe('/handbook.docx');
    expect(out.name).toBe('Team Handbook');
  });

  test('alias absent → name unset (File.tsx falls back to basenameFromUrl)', () => {
    if (!wikiEmbedFile) throw new Error('descriptor missing');
    const out = wikiEmbedFile.translateProps({
      src: '/handbook.docx',
      target: 'handbook.docx',
    });
    expect(out.name).toBeUndefined();
  });

  test('alias empty string → name unset (treated as missing alias)', () => {
    if (!wikiEmbedFile) throw new Error('descriptor missing');
    const out = wikiEmbedFile.translateProps({
      src: '/handbook.docx',
      target: 'handbook.docx',
      alias: '',
    });
    expect(out.name).toBeUndefined();
  });

  test('PDF wiki-embed routes through the File path (uniform with other dropped attachments)', () => {
    if (!wikiEmbedFile) throw new Error('descriptor missing');
    const out = wikiEmbedFile.translateProps({
      src: '/spec.pdf',
      target: 'spec.pdf',
      alias: 'Project Spec',
    });
    expect(out.src).toBe('/spec.pdf');
    expect(out.name).toBe('Project Spec');
  });
});

describe('WikiEmbedFile.serialize — source-form mdast emit', () => {
  function callSerialize(node: PmNode) {
    if (!wikiEmbedFile) throw new Error('descriptor missing');
    return wikiEmbedFile.serialize(node, {
      all: () => [],
      registry: { getOrWildcard: () => wikiEmbedFile },
      serializeChildren: () => '',
    });
  }

  test('plain target (no alias) → wikiLinkEmbed with target as label', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedFile', { src: '/handbook.docx', target: 'handbook.docx' }),
    );
    const cast = out as unknown as {
      type: string;
      value: string;
      data: { target: string; anchor: string | null; alias: string | null };
    };
    expect(cast.type).toBe('wikiLinkEmbed');
    expect(cast.value).toBe('handbook.docx');
    expect(cast.data.target).toBe('handbook.docx');
    expect(cast.data.alias).toBeNull();
  });

  test('alias-bearing target → label uses alias (`![[file|Label]]` byte-stable)', () => {
    const out = callSerialize(
      makeMockNode('WikiEmbedFile', {
        src: '/handbook.docx',
        target: 'handbook.docx',
        alias: 'Team Handbook',
      }),
    );
    const cast = out as unknown as { value: string; data: { alias: string | null } };
    expect(cast.value).toBe('Team Handbook');
    expect(cast.data.alias).toBe('Team Handbook');
  });
});
