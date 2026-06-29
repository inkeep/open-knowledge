import { describe, expect, test } from 'bun:test';
import { Box, Image } from 'lucide-react';
import { getDescriptor } from './index.ts';
import {
  resolveDescriptorPlaceholder,
  shouldRenderPlaceholder,
} from './resolve-descriptor-placeholder.ts';

describe('shouldRenderPlaceholder', () => {
  test('img with empty src → true', () => {
    const img = getDescriptor('img');
    expect(shouldRenderPlaceholder(img, { src: '' })).toBe(true);
  });

  test('img with valid src → false', () => {
    const img = getDescriptor('img');
    expect(shouldRenderPlaceholder(img, { src: '/p.png' })).toBe(false);
  });

  test("img with valid src + alt='' → false (alt is not the autoFocus prop)", () => {
    const img = getDescriptor('img');
    expect(shouldRenderPlaceholder(img, { src: '/p.png', alt: '' })).toBe(false);
  });

  test('img with src=undefined → false (undefined ≠ "" preserves authored-empty semantics)', () => {
    const img = getDescriptor('img');
    expect(shouldRenderPlaceholder(img, { src: undefined })).toBe(false);
  });

  test("Callout with title='' → false (hasChildren=true descriptors are excluded)", () => {
    const callout = getDescriptor('Callout');
    expect(shouldRenderPlaceholder(callout, { title: '' })).toBe(false);
  });

  test("Accordion with title='' → false (hasChildren=true descriptors are excluded)", () => {
    const accordion = getDescriptor('Accordion');
    expect(shouldRenderPlaceholder(accordion, { title: '' })).toBe(false);
  });

  test('wildcard "*" descriptor → false (no editable props → no autoFocus prop)', () => {
    const wildcard = getDescriptor('NonExistent-falls-through-to-wildcard');
    expect(shouldRenderPlaceholder(wildcard, {})).toBe(false);
  });

  test('video with empty src → true', () => {
    const video = getDescriptor('video');
    expect(shouldRenderPlaceholder(video, { src: '' })).toBe(true);
  });

  test('audio with empty src → true', () => {
    const audio = getDescriptor('audio');
    expect(shouldRenderPlaceholder(audio, { src: '' })).toBe(true);
  });
});

describe('resolveDescriptorPlaceholder', () => {
  test('img returns the descriptor placeholder.label override', () => {
    const img = getDescriptor('img');
    const resolved = resolveDescriptorPlaceholder(img);
    expect(resolved.label).toBe('Add an image');
    expect(resolved.Icon).toBe(Image);
  });

  test('video returns the descriptor placeholder.label override', () => {
    const video = getDescriptor('video');
    const resolved = resolveDescriptorPlaceholder(video);
    expect(resolved.label).toBe('Add a video');
  });

  test('audio returns the descriptor placeholder.label override', () => {
    const audio = getDescriptor('audio');
    const resolved = resolveDescriptorPlaceholder(audio);
    expect(resolved.label).toBe('Add audio');
  });

  test('label fallback derives from displayName.toLowerCase() when no override', () => {
    const synthetic = {
      name: 'Synthetic',
      hasChildren: false,
      props: [],
      displayName: 'Synthetic',
      icon: 'Image',
    };
    expect(
      resolveDescriptorPlaceholder(
        synthetic as unknown as Parameters<typeof resolveDescriptorPlaceholder>[0],
      ).label,
    ).toBe('Add synthetic');
  });

  test('Icon override via placeholder.icon takes precedence over descriptor.icon', () => {
    const synthetic = {
      name: 'Synthetic',
      hasChildren: false,
      props: [],
      displayName: 'Synthetic',
      icon: 'SquarePlay',
      placeholder: { icon: 'Image' },
    };
    expect(
      resolveDescriptorPlaceholder(
        synthetic as unknown as Parameters<typeof resolveDescriptorPlaceholder>[0],
      ).Icon,
    ).toBe(Image);
  });

  test('Icon falls back to Box when neither override nor descriptor.icon resolve', () => {
    const synthetic = {
      name: 'Synthetic',
      hasChildren: false,
      props: [],
      displayName: 'Synthetic',
    };
    expect(
      resolveDescriptorPlaceholder(
        synthetic as unknown as Parameters<typeof resolveDescriptorPlaceholder>[0],
      ).Icon,
    ).toBe(Box);
  });
});
