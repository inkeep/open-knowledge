/**
 * Shared OpenGraph card primitives. Three card variants share the same
 * visual language (dot grid background, wordmark top-left, body bottom-
 * left): BrandCard (site-wide fallback + invalid/unsupported splash),
 * DocPageCard (per-docs-page using page title), ShareCard (valid share-
 * splash with filename + repo path).
 *
 * Why satori-specific quirks live here, not in the standard component
 * library: satori does NOT reliably render CSS radial-gradient backgrounds,
 * url(svg-data-url) tiled patterns, or SVG <pattern> fills. The dot grid
 * and mask therefore brute-force <circle> elements with JS-computed per-
 * dot opacity. The standard component library renders in a real browser
 * and has different reliability characteristics.
 */
import type { ReactNode } from 'react';
import { OK_WORDMARK_DATA_URL } from './ok-wordmark.data';
import { SITE_HEADLINE } from './site';

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = 'image/png';
export const OG_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
} as const;

const BG = '#fbf9f4';
const TEXT = '#1a1a1a';
const MUTED = '#71717a';
const ACCENT = '#3784ff'; // matches --slide-accent (light)
const DOT_COLOR = '#e3e3e1';
const DOT_SPACING = 24;
const DOT_RADIUS = 1.8;
const MASK_INNER = 0.7;
const MASK_OUTER = 1.3;
const PAD_X = 72;
const PAD_Y = 64;
// Platforms (X/Twitter, iMessage, Slack) overlay a title/domain chip across the
// bottom-left of the card. Reserve extra bottom space so body text clears it.
const SAFE_BOTTOM = 96;
const CARD_W = OG_SIZE.width;
const CARD_H = OG_SIZE.height;

// Must match the wordmark SVG's viewBox aspect ratio, else satori stretches it.
const WORDMARK_NATURAL_W = 1307;
const WORDMARK_NATURAL_H = 252;
const WORDMARK_HEIGHT = 44;
const WORDMARK_WIDTH = Math.round((WORDMARK_HEIGHT * WORDMARK_NATURAL_W) / WORDMARK_NATURAL_H);

const wordmarkDataUrl = OK_WORDMARK_DATA_URL;

interface MaskEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * Renders a uniform dot grid with elliptical fade-to-zero regions behind
 * the supplied mask centers, so dots don't fight with text.
 */
function DotGrid({ masks }: { masks: MaskEllipse[] }) {
  const cols = Math.ceil(CARD_W / DOT_SPACING);
  const rows = Math.ceil(CARD_H / DOT_SPACING);
  const dots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = c * DOT_SPACING + DOT_SPACING / 2;
      const cy = r * DOT_SPACING + DOT_SPACING / 2;
      let nearest = Infinity;
      for (const m of masks) {
        const d = Math.hypot((cx - m.cx) / m.rx, (cy - m.cy) / m.ry);
        if (d < nearest) nearest = d;
      }
      const opacity = Math.min(1, Math.max(0, (nearest - MASK_INNER) / (MASK_OUTER - MASK_INNER)));
      if (opacity < 0.03) continue;
      dots.push(
        <circle
          key={`${r}-${c}`}
          cx={cx}
          cy={cy}
          r={DOT_RADIUS}
          fill={DOT_COLOR}
          opacity={opacity.toFixed(3)}
        />,
      );
    }
  }
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: CARD_W,
        height: CARD_H,
        display: 'flex',
      }}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: rasterized to PNG by satori; ARIA never reaches an a11y tree. */}
      <svg width={CARD_W} height={CARD_H} viewBox={`0 0 ${CARD_W} ${CARD_H}`}>
        {dots}
      </svg>
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {/* biome-ignore lint: satori renders a raster; next/image is browser-only and requires explicit dimensions here. */}
      <img
        src={wordmarkDataUrl}
        width={WORDMARK_WIDTH}
        height={WORDMARK_HEIGHT}
        alt="OpenKnowledge"
      />
    </div>
  );
}

/** lucide `git-branch`, inlined for satori (matches the splash page's branch row). */
function GitBranchIcon() {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: rasterized to PNG by satori; ARIA never reaches an a11y tree.
    <svg
      width={26}
      height={26}
      viewBox="0 0 24 24"
      fill="none"
      stroke={MUTED}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** Blue uppercase tag above a card headline (mirrors the site's section eyebrow). */
function Eyebrow({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: ACCENT,
        marginBottom: 18,
      }}
    >
      {label}
    </span>
  );
}

function Filename({ filename, fontSize = 88 }: { filename: string; fontSize?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <h1
        style={{
          fontSize,
          fontWeight: 300,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: 0,
          color: TEXT,
          overflowWrap: 'break-word',
        }}
      >
        {filename}
      </h1>
    </div>
  );
}

function CardFrame({ masks, children }: { masks: MaskEllipse[]; children: ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        backgroundColor: BG,
        fontFamily: 'DM Sans',
        color: TEXT,
      }}
    >
      <DotGrid masks={masks} />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          padding: `${PAD_Y}px ${PAD_X}px ${PAD_Y + SAFE_BOTTOM}px`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const LOGO_MASK: MaskEllipse = { cx: 200, cy: 86, rx: 260, ry: 70 };
const BODY_MASK: MaskEllipse = { cx: 400, cy: 420, rx: 650, ry: 220 };

/**
 * Site-wide brand card. Used by app/opengraph-image.tsx (covers home and
 * any route without its own OG image) AND as the fallback rendering for
 * invalid/unsupported share-splash URLs.
 */
export function BrandCard() {
  return (
    <CardFrame masks={[LOGO_MASK, BODY_MASK]}>
      <Wordmark />
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 1056 }}>
        <Eyebrow label="Open source" />
        <h1
          style={{
            fontSize: 76,
            fontWeight: 300,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            margin: 0,
            whiteSpace: 'pre-line',
          }}
        >
          {SITE_HEADLINE}
        </h1>
      </div>
    </CardFrame>
  );
}

/**
 * Per-doc-page card. Page title becomes the bottom-left headline;
 * description rides below as a muted subtitle.
 */
export function DocPageCard({
  title,
  description,
}: {
  title: string;
  description?: string | null;
}) {
  return (
    <CardFrame masks={[LOGO_MASK, BODY_MASK]}>
      <Wordmark />
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 1056 }}>
        <Eyebrow label="Docs" />
        <Filename filename={title} fontSize={titleFontSize(title)} />
        {description ? (
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              fontWeight: 500,
              color: MUTED,
              marginTop: 28,
              maxWidth: 1000,
            }}
          >
            <span>{description}</span>
          </div>
        ) : null}
      </div>
    </CardFrame>
  );
}

/** Drop one or two notches for long titles so they fit the bottom-left band. */
function titleFontSize(title: string): number {
  if (title.length > 36) return 64;
  if (title.length > 24) return 76;
  return 88;
}

/**
 * Share-splash happy-path card. Bespoke layout — filename anchors the
 * composition; repo path + optional branch ride below as a muted line.
 */
export function ShareCard({
  filename,
  repoPath,
  branch,
  isDefaultBranch,
  target = 'doc',
}: {
  filename: string;
  repoPath: string;
  branch: string;
  isDefaultBranch: boolean;
  target?: 'doc' | 'folder';
}) {
  return (
    <CardFrame masks={[LOGO_MASK, BODY_MASK]}>
      <Wordmark />
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 1056 }}>
        <Eyebrow label={target === 'folder' ? 'Shared folder' : 'Shared'} />
        <Filename filename={filename} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            fontSize: 28,
            fontWeight: 500,
            color: MUTED,
            marginTop: 28,
          }}
        >
          <span>{repoPath}</span>
          {isDefaultBranch ? null : (
            <span style={{ display: 'flex', alignItems: 'center', marginLeft: 18, color: MUTED }}>
              <span style={{ opacity: 0.5, marginRight: 18 }}>•</span>
              <GitBranchIcon />
              <span style={{ fontWeight: 500, marginLeft: 10 }}>{branch}</span>
            </span>
          )}
        </div>
      </div>
    </CardFrame>
  );
}

export interface FontPair {
  light: ArrayBuffer;
  medium: ArrayBuffer;
}

const DM_SANS_LIGHT_URL =
  'https://fonts.gstatic.com/s/dmsans/v15/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAo69EBlec.ttf';
const DM_SANS_MEDIUM_URL =
  'https://fonts.gstatic.com/s/dmsans/v15/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAoa9EBlec.ttf';

export async function loadDmSans(): Promise<FontPair | null> {
  try {
    const [light, medium] = await Promise.all([
      fetch(DM_SANS_LIGHT_URL).then((r) => (r.ok ? r.arrayBuffer() : null)),
      fetch(DM_SANS_MEDIUM_URL).then((r) => (r.ok ? r.arrayBuffer() : null)),
    ]);
    if (!light || !medium) return null;
    return { light, medium };
  } catch {
    return null;
  }
}

export function dmSansFontsArg(fonts: FontPair | null) {
  return fonts
    ? [
        { name: 'DM Sans', data: fonts.light, weight: 300 as const, style: 'normal' as const },
        { name: 'DM Sans', data: fonts.medium, weight: 500 as const, style: 'normal' as const },
      ]
    : undefined;
}
