import { Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';

const RINGS = [56, 82, 108] as const;
const RING_CENTER = { x: 80, y: 45 };

const CARD_BG = 'var(--slide-bg-elevated)';
const CARD_RADIUS = '3.6cqw';
const BACK_SHADOW = '0 1px 2px rgba(15, 23, 42, 0.05), 0 6px 18px -8px rgba(15, 23, 42, 0.12)';
const FRONT_SHADOW = '0 1px 3px rgba(15, 23, 42, 0.07), 0 16px 34px -10px rgba(15, 23, 42, 0.18)';
const MUTED_FILL = 'color-mix(in srgb, var(--slide-muted) 14%, transparent)';

type Avatar = { label?: string; agent?: boolean; bg: string; fg: string };

const AVATARS: Avatar[] = [
  { label: 'M', bg: '#f0ece3', fg: '#78716c' },
  { label: 'J', bg: 'var(--color-orange-light)', fg: '#b45309' },
  { agent: true, bg: 'var(--color-crystal-blue)', fg: 'var(--color-azure-blue)' },
  { label: 'K', bg: 'var(--color-purple-light)', fg: '#6d28d9' },
];

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

function CardSkeletonLine({ width, delay }: { width: string; delay: string }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{ height: '2.1cqw', width, borderRadius: '9999px', backgroundColor: MUTED_FILL }}
    >
      <div
        className="ok-kb-shimmer absolute inset-y-0"
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

function Avatars() {
  return (
    <div className="flex items-center">
      {AVATARS.map((a, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static roster
          key={i}
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: '5.8cqw',
            height: '5.8cqw',
            marginLeft: i === 0 ? 0 : '-1.7cqw',
            backgroundColor: a.bg,
            color: a.fg,
            border: '0.5cqw solid var(--slide-bg-elevated)',
            fontSize: '2.5cqw',
            fontWeight: 600,
          }}
        >
          {a.agent ? (
            <Sparkles
              style={{ width: '3.1cqw', height: '3.1cqw' }}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          ) : (
            a.label
          )}
        </div>
      ))}
    </div>
  );
}

function BackCard({
  title,
  align,
  style,
}: {
  title: string;
  align: 'top' | 'bottom';
  style: CSSProperties;
}) {
  return (
    <div
      className={`absolute flex flex-col overflow-hidden ${align === 'bottom' ? 'justify-end' : 'justify-start'}`}
      style={style}
    >
      <div
        style={{
          padding: '4.5cqw',
          fontSize: '3.2cqw',
          fontWeight: 600,
          color:
            align === 'bottom'
              ? 'color-mix(in srgb, var(--slide-text) 55%, transparent)'
              : 'var(--slide-muted)',
        }}
      >
        {title}
      </div>
    </div>
  );
}

export function KnowledgeBaseGraphic() {
  return (
    <div className="@container relative h-full w-full overflow-hidden" aria-hidden="true">
      <style>{`
        @keyframes ok-kb-shimmer {
          0% { transform: translateX(-160%); }
          45% { transform: translateX(360%); }
          100% { transform: translateX(360%); }
        }
        .ok-kb-shimmer { animation: ok-kb-shimmer 5.5s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .ok-kb-shimmer { animation: none !important; }
        }
      `}</style>

      <BackgroundRings />

      <BackCard
        title="Oncall guide"
        align="top"
        style={{
          left: '30%',
          top: '-8%',
          width: '50%',
          height: '30%',
          transform: 'rotate(-3.5deg)',
          backgroundColor: CARD_BG,
          borderRadius: CARD_RADIUS,
          boxShadow: BACK_SHADOW,
        }}
      />

      <BackCard
        title="Incident postmortem"
        align="bottom"
        style={{
          left: '15%',
          top: '74%',
          width: '50%',
          height: '30%',
          transform: 'rotate(3.2deg)',
          backgroundColor: CARD_BG,
          borderRadius: CARD_RADIUS,
          boxShadow: BACK_SHADOW,
        }}
      />

      <div
        className="absolute flex flex-col overflow-hidden"
        style={{
          left: '22%',
          top: '11%',
          width: '56%',
          height: '78%',
          padding: '4.5cqw',
          transform: 'rotate(-1.2deg)',
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
          DOCS
        </div>
        <div
          style={{
            marginTop: '1.8cqw',
            fontSize: '5.6cqw',
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            color: 'color-mix(in srgb, var(--slide-text) 88%, transparent)',
          }}
        >
          Deploy runbook
        </div>
        <div style={{ marginTop: '1.4cqw', fontSize: '2.7cqw', color: 'var(--slide-muted)' }}>
          Updated 2 hours ago
        </div>

        <div className="flex flex-col" style={{ marginTop: '3.4cqw', gap: '2.1cqw' }}>
          <CardSkeletonLine width="100%" delay="0s" />
          <CardSkeletonLine width="62%" delay="0.7s" />
        </div>

        <div className="flex-1" />

        <div
          style={{
            height: '1px',
            width: '100%',
            backgroundColor: 'color-mix(in srgb, var(--slide-text) 8%, transparent)',
          }}
        />
        <div className="flex items-center" style={{ marginTop: '3cqw' }}>
          <Avatars />
          <span
            style={{
              marginLeft: '2cqw',
              fontSize: '2.2cqw',
              whiteSpace: 'nowrap',
              color: 'var(--slide-muted)',
            }}
          >
            Kept current by 12 people
          </span>
        </div>
      </div>
    </div>
  );
}
