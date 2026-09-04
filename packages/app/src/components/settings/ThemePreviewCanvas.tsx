import type { Base16Scheme, Base16Slot } from '@inkeep/open-knowledge-core';
import { base16ToTokens } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';

interface ThemePreviewCanvasProps {
  scheme: Base16Scheme;
  highlightSlot?: Base16Slot | null;
  className?: string;
}

function Lit({
  slot,
  active,
  className,
  style,
  children,
}: {
  slot: Base16Slot;
  active: Base16Slot | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const on = active === slot;
  return (
    <span
      data-slot={slot}
      data-lit={on ? 'true' : undefined}
      className={cn('rounded-[2px] transition-shadow', on && 'ring-2 ring-offset-1', className)}
      style={{
        ...style,
        ...(on ? { boxShadow: '0 0 0 2px currentColor' } : null),
      }}
    >
      {children}
    </span>
  );
}

export function ThemePreviewCanvas({ scheme, highlightSlot, className }: ThemePreviewCanvasProps) {
  const { t } = useLingui();
  const p = scheme.palette;
  const tok = base16ToTokens(scheme);
  const hl = highlightSlot ?? null;

  return (
    <div
      aria-label={t`Theme preview`}
      role="img"
      className={cn(
        'overflow-hidden rounded-lg border text-[9px] leading-[1.5] select-none',
        className,
      )}
      style={{ backgroundColor: p.base00, color: p.base05, borderColor: p.base02 }}
    >
      {}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5"
        style={{ backgroundColor: p.base01, borderBottom: `1px solid ${p.base02}` }}
      >
        <Lit slot="base0D" active={hl}>
          <span
            className="inline-block rounded-full px-1.5 py-[1px] font-medium"
            style={{ backgroundColor: p.base0D, color: p.base00 }}
          >
            {t`Save`}
          </span>
        </Lit>
        <Lit slot="base04" active={hl} className="flex-1 truncate">
          <span style={{ color: p.base04 }}>notes / release-plan.md</span>
        </Lit>
      </div>

      <div className="flex">
        {}
        <div
          className="w-[26%] shrink-0 space-y-[3px] p-1.5"
          style={{ backgroundColor: p.base01, borderRight: `1px solid ${p.base02}` }}
        >
          <Lit
            slot="base02"
            active={hl}
            className="block rounded px-1 py-[1px]"
            style={{ backgroundColor: p.base02 }}
          >
            <span style={{ color: p.base05 }}>release-plan</span>
          </Lit>
          <Lit slot="base04" active={hl} className="block px-1">
            <span style={{ color: p.base04 }}>backlog</span>
          </Lit>
          <Lit slot="base04" active={hl} className="block px-1">
            <span style={{ color: p.base04 }}>archive</span>
          </Lit>
        </div>

        {}
        <div className="min-w-0 flex-1 space-y-1.5 p-2">
          <Lit slot="base0D" active={hl} className="block font-semibold">
            <span style={{ color: tok['syntax-func'] }}>{t`Release plan`}</span>
          </Lit>

          <div className="space-y-[2px]">
            <span style={{ color: p.base05 }}>{t`Ship the editor with a`} </span>
            <Lit slot="base0D" active={hl}>
              <span style={{ color: tok['link-color'], textDecoration: 'underline' }}>
                {t`themed preview`}
              </span>
            </Lit>
            <span style={{ color: p.base05 }}>.</span>
          </div>

          {}
          <Lit
            slot="base0A"
            active={hl}
            className="block rounded px-1.5 py-1"
            style={{
              backgroundColor: p.base01,
              borderLeft: `2px solid ${tok['callout-warning-color']}`,
            }}
          >
            <span style={{ color: tok['callout-warning-color'] }} className="font-medium">
              {t`Warning`}
            </span>
          </Lit>

          {}
          <div
            className="rounded px-1.5 py-1 font-mono"
            style={{ backgroundColor: tok['syntax-bg'] }}
          >
            <div>
              <Lit slot="base0E" active={hl}>
                <span style={{ color: tok['syntax-keyword'] }}>const</span>
              </Lit>{' '}
              <Lit slot="base08" active={hl}>
                <span style={{ color: tok['syntax-var'] }}>retries</span>
              </Lit>
              <span style={{ color: tok['syntax-operator'] }}> = </span>
              <Lit slot="base09" active={hl}>
                <span style={{ color: tok['syntax-number'] }}>3</span>
              </Lit>
            </div>
            <div>
              <Lit slot="base0B" active={hl}>
                <span style={{ color: tok['syntax-string'] }}>"ready"</span>
              </Lit>{' '}
              <Lit slot="base03" active={hl}>
                <span style={{ color: tok['syntax-comment'], fontStyle: 'italic' }}>
                  {t`// note`}
                </span>
              </Lit>
            </div>
          </div>

          {}
          <div
            className="flex items-center gap-1 rounded px-1.5 py-1 font-mono"
            style={{ backgroundColor: p.base00, border: `1px solid ${p.base02}` }}
          >
            <span style={{ color: p.base04 }}>$</span>
            {(
              [
                ['base08', tok['ansi-red']],
                ['base0A', tok['ansi-yellow']],
                ['base0B', tok['ansi-green']],
                ['base0C', tok['ansi-cyan']],
                ['base0D', tok['ansi-blue']],
                ['base0E', tok['ansi-magenta']],
              ] as const
            ).map(([slot, color]) => (
              <Lit key={slot} slot={slot as Base16Slot} active={hl}>
                <span
                  className="inline-block size-1.5 rounded-[1px]"
                  style={{ backgroundColor: color }}
                />
              </Lit>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
