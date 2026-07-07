/**
 * `shouldRenderPlaceholder` decides when JsxComponentView swaps the rendered
 * component for the empty-state placeholder pill (Notion-style "Add an image"
 * UI). It is intentionally STRICTER than `needsConfig` — `needsConfig` flags
 * any required string prop with a missing-key decision (e.g. `alt` absent on
 * an `<img>`), but the placeholder is for cases where the component literally
 * cannot render anything useful, i.e. the autoFocus-flagged required prop is
 * empty. `selection-indicator.e2e.ts` is the regression canary for
 * this distinction.
 *
 * `resolveDescriptorPlaceholder` derives the label / Icon to display, with a
 * fallback ladder: descriptor.placeholder.label || `Add ${displayName.toLowerCase()}`,
 * and descriptor.placeholder.icon || descriptor.icon || Box.
 */
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

// Note: the broader manifest-level placeholder-contract guard lives in
// `packages/core/src/registry/registry.test.ts` (asserts defaultValue + autoFocus
// + not-advanced together on img/video/audio's `src` prop). Keeping the
// invariant in the manifest test file rather than here puts it next to the
// source of truth (built-ins.ts) — a future demote/promote PR is more likely
// to run registry.test.ts than a dedicated resolver test.
