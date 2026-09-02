import { describe, expect, it } from 'vitest';
import { type AnchorViewport, scrollDeltaForAnchor } from './scroll-to-anchor';

const view = (anchorTop: number, anchorBottom: number): AnchorViewport => ({
  anchorTop,
  anchorBottom,
  viewTop: 100,
  viewBottom: 900,
  insetTop: 56,
});

function landsAt(v: AnchorViewport): number {
  return v.anchorTop - scrollDeltaForAnchor(v);
}

describe('scrollDeltaForAnchor', () => {
  it('leaves a comfortably placed passage alone', () => {
    expect(scrollDeltaForAnchor(view(300, 320))).toBe(0);
  });

  it('pulls up a passage sitting too low for its card to fit beneath', () => {
    const v = view(880, 900);
    expect(scrollDeltaForAnchor(v)).toBeGreaterThan(0);
    expect(landsAt(v)).toBe(180);
  });

  it('clears a passage hidden behind the floating toolbar', () => {
    const v = view(120, 140);
    expect(scrollDeltaForAnchor(v)).toBeLessThan(0);
    expect(landsAt(v)).toBe(180);
  });

  it('scrolls back up to a passage above the viewport', () => {
    const v = view(-400, -380);
    expect(landsAt(v)).toBe(180);
  });

  it('nudges a passage whose tail runs past the resting band', () => {
    expect(scrollDeltaForAnchor(view(200, 700))).toBe(20);
  });

  it('counts the inset as unusable, not merely as padding', () => {
    const withInset = view(120, 140);
    const withoutInset = { ...withInset, insetTop: 0 };
    expect(scrollDeltaForAnchor(withInset)).toBeLessThan(0);
    expect(scrollDeltaForAnchor(withoutInset)).toBe(0);
  });

  it('still places the passage near the top when the scrollport is tiny', () => {
    const v: AnchorViewport = {
      anchorTop: 50,
      anchorBottom: 60,
      viewTop: 0,
      viewBottom: 200,
      insetTop: 0,
    };
    expect(landsAt(v)).toBe(24);
  });
});
