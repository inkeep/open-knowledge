import { Code, Sparkles } from 'lucide-react';

const RINGS = [56, 82, 108] as const;
const RING_CENTER = { x: 80, y: 45 };

const CARD_BG = 'var(--slide-bg-elevated)';
const CARD_RADIUS = '3.6cqw';
const FRONT_SHADOW = '0 1px 3px rgba(15, 23, 42, 0.07), 0 16px 34px -10px rgba(15, 23, 42, 0.18)';
const BACK_SHADOW = '0 1px 2px rgba(15, 23, 42, 0.05), 0 6px 18px -8px rgba(15, 23, 42, 0.12)';

const LINE_FILL = 'color-mix(in srgb, var(--slide-text) 13%, transparent)';
const ACCENT_LINE = 'color-mix(in srgb, var(--slide-accent) 45%, transparent)';
const HAIRLINE = 'color-mix(in srgb, var(--slide-text) 8%, transparent)';
const MUTED_FILL = 'color-mix(in srgb, var(--slide-muted) 14%, transparent)';

function BackgroundRings() {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 160 90"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {RINGS.map((r) => (
        <circle
          key={r}
          cx={RING_CENTER.x}
          cy={RING_CENTER.y}
          r={r}
          fill="none"
          style={{ stroke: 'color-mix(in srgb, var(--slide-text) 10%, transparent)' }}
          strokeWidth={1}
          strokeDasharray="1.5 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

type Seg = { w: string; accent?: boolean };

function CodeLine({ indent, segs }: { indent?: string; segs: Seg[] }) {
  return (
    <div className="flex items-center" style={{ gap: '1.1cqw', marginLeft: indent }}>
      {segs.map((s, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static token layout
          key={i}
          style={{
            height: '1.7cqw',
            width: s.w,
            borderRadius: '9999px',
            backgroundColor: s.accent ? ACCENT_LINE : LINE_FILL,
          }}
        />
      ))}
    </div>
  );
}

function SkeletonLine({ width, delay }: { width: string; delay: string }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{ height: '2.1cqw', width, borderRadius: '9999px', backgroundColor: MUTED_FILL }}
    >
      <div
        className="ok-spec-shimmer absolute inset-y-0"
        style={{
          width: '50%',
          animationDelay: delay,
          background:
            'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.7) 50%, transparent 100%)',
        }}
      />
    </div>
  );
}

function CodeCard() {
  return (
    <div
      className="absolute flex flex-col overflow-hidden"
      style={{
        left: '9%',
        top: '15%',
        width: '43%',
        height: '69%',
        transform: 'rotate(-5deg)',
        backgroundColor: CARD_BG,
        borderRadius: CARD_RADIUS,
        boxShadow: BACK_SHADOW,
      }}
    >
      <div
        className="flex items-center"
        style={{
          gap: '1.6cqw',
          padding: '3.2cqw 3.6cqw',
          borderBottom: `1px solid ${HAIRLINE}`,
        }}
      >
        <Code
          style={{ width: '3.4cqw', height: '3.4cqw', color: 'var(--slide-accent)' }}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span
          style={{
            fontSize: '2.6cqw',
            fontWeight: 600,
            color: 'var(--slide-muted)',
            fontFamily: 'var(--font-geist-mono, ui-monospace, monospace)',
          }}
        >
          auth.ts
        </span>
      </div>

      <div className="flex flex-1 flex-col" style={{ padding: '3.6cqw', gap: '2.4cqw' }}>
        <CodeLine segs={[{ w: '14%', accent: true }, { w: '30%' }, { w: '20%' }]} />
        <CodeLine indent="4cqw" segs={[{ w: '22%', accent: true }, { w: '40%' }]} />
        <CodeLine indent="4cqw" segs={[{ w: '34%' }, { w: '18%', accent: true }]} />
        <CodeLine indent="4cqw" segs={[{ w: '16%', accent: true }, { w: '24%' }, { w: '14%' }]} />
        <CodeLine segs={[{ w: '10%' }]} />
      </div>
    </div>
  );
}

function SpecCard() {
  return (
    <div
      className="absolute flex flex-col overflow-hidden"
      style={{
        left: '44%',
        top: '11%',
        width: '47%',
        height: '79%',
        padding: '4.4cqw',
        transform: 'rotate(3.5deg)',
        backgroundColor: CARD_BG,
        borderRadius: CARD_RADIUS,
        boxShadow: FRONT_SHADOW,
      }}
    >
      <div
        style={{
          fontSize: '2.2cqw',
          fontWeight: 600,
          letterSpacing: '0.22em',
          color: 'var(--slide-muted)',
        }}
      >
        SPEC
      </div>
      <div
        style={{
          marginTop: '1.6cqw',
          fontSize: '5.4cqw',
          fontWeight: 600,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          color: 'color-mix(in srgb, var(--slide-text) 88%, transparent)',
        }}
      >
        Auth service
      </div>

      <div className="flex flex-col" style={{ marginTop: '3.4cqw', gap: '2.2cqw' }}>
        <SkeletonLine width="100%" delay="0s" />
        <SkeletonLine width="88%" delay="0.7s" />
        <SkeletonLine width="94%" delay="1.4s" />
      </div>

      <div className="flex-1" />

      <div className="flex items-center" style={{ gap: '2cqw' }}>
        <div className="flex items-center">
          <div
            className="flex shrink-0 items-center justify-center rounded-full"
            style={{
              width: '5.6cqw',
              height: '5.6cqw',
              backgroundColor: 'var(--color-orange-light)',
              color: '#b45309',
              border: '0.5cqw solid var(--slide-bg-elevated)',
              fontSize: '2.4cqw',
              fontWeight: 600,
            }}
          >
            S
          </div>
          <div
            className="flex shrink-0 items-center justify-center rounded-full"
            style={{
              width: '5.6cqw',
              height: '5.6cqw',
              marginLeft: '-1.6cqw',
              backgroundColor: 'var(--color-crystal-blue)',
              color: 'var(--color-azure-blue)',
              border: '0.5cqw solid var(--slide-bg-elevated)',
            }}
          >
            <Sparkles
              style={{ width: '3cqw', height: '3cqw' }}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </div>
        </div>
        <span style={{ fontSize: '2.2cqw', whiteSpace: 'nowrap', color: 'var(--slide-muted)' }}>
          You and your agents
        </span>
      </div>
    </div>
  );
}

export function EngSpecsGraphic() {
  return (
    <div className="@container relative h-full w-full overflow-hidden" aria-hidden="true">
      <style>{`
        @keyframes ok-spec-shimmer {
          0% { transform: translateX(-160%); }
          45% { transform: translateX(360%); }
          100% { transform: translateX(360%); }
        }
        .ok-spec-shimmer { animation: ok-spec-shimmer 5.5s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .ok-spec-shimmer { animation: none !important; }
        }
      `}</style>

      <BackgroundRings />
      <CodeCard />
      <SpecCard />
    </div>
  );
}
