import { describe, expect, it } from 'vitest';
import { type AnchorViewport, scrollDeltaForAnchor } from './scroll-to-anchor';

/** A scrollport 800px tall with the usual toolbar strip across its top. */
const view = (anchorTop: number, anchorBottom: number): AnchorViewport => ({
  anchorTop,
  anchorBottom,
  viewTop: 100,
  viewBottom: 900,
  insetTop: 56,
});

/** Where the passage's top lands after applying the delta. */
function landsAt(v: AnchorViewport): number {
  return v.anchorTop - scrollDeltaForAnchor(v);
}

describe('scrollDeltaForAnchor', () => {
  it('leaves a comfortably placed passage alone', () => {
    expect(scrollDeltaForAnchor(view(300, 320))).toBe(0);
  });

  it('pulls up a passage sitting too low for its card to fit beneath', () => {
    // Visible, but only 20px from the bottom — the thread card would open
    // off-screen, which is the whole complaint.
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
    // A quote spanning most of the scrollport: its start is fine, its end is
    // not, so it moves just enough to open room underneath.
    expect(scrollDeltaForAnchor(view(200, 700))).toBe(20);
  });

  it('counts the inset as unusable, not merely as padding', () => {
    const withInset = view(120, 140);
    const withoutInset = { ...withInset, insetTop: 0 };
    expect(scrollDeltaForAnchor(withInset)).toBeLessThan(0);
    expect(scrollDeltaForAnchor(withoutInset)).toBe(0);
  });

  it('still places the passage near the top when the scrollport is tiny', () => {
    // Shorter than the room a card needs: nothing can be comfortable, so the
    // passage goes as high as it can rather than staying put.
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
