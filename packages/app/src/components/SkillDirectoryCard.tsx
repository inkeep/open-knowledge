import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Directory-card shell for the Explore (skills.sh search) skill list. The whole
 * card is a keyboard-accessible "open preview" stretched link. A top row holds
 * an optional `leading` (avatar/logo), the stacked title + `meta` (name over
 * publisher · installs), and `action` on the right; `description` spans full
 * width on its own row below. The hover/focus shell and overlay button live
 * here so every row renders identically.
 */
export function SkillDirectoryCard({
  name,
  description,
  onOpen,
  onHover,
  action,
  meta,
  leading,
}: {
  name: string;
  description?: string | null;
  onOpen: () => void;
  /** Fires when the card is first pointed at or focused. Used to resolve
   *  hover-only detail (the context-cost figure); a card never hovered must
   *  never trigger the work, so this is deliberately not called on mount. */
  onHover?: () => void;
  action: ReactNode;
  meta: ReactNode;
  leading?: ReactNode;
}) {
  const { t } = useLingui();
  const title = <div className="truncate font-medium text-sm">{name}</div>;
  return (
    <li
      className="relative rounded-xl border border-border bg-card p-4 transition-colors hover:border-border/60 hover:bg-accent/40 focus-within:ring-2 focus-within:ring-ring"
      onMouseEnter={onHover}
      // Keyboard users never fire onMouseEnter, so focus is the equivalent
      // trigger; `onFocus` bubbles from the stretched-link button inside.
      onFocus={onHover}
    >
      {/* Stretched-link overlay covers the whole card (keyboard-accessible,
          semantic — an li can't be interactive). It's positioned, so it paints
          above the static rows below and catches clicks anywhere; the `action`
          re-establishes its own stacking (relative z-10) to stay clickable. */}
      <Button
        variant="ghost"
        aria-label={t`View ${name}`}
        onClick={onOpen}
        className="absolute inset-0 h-auto w-full rounded-xl p-0 opacity-0"
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          {leading ? <div className="shrink-0">{leading}</div> : null}
          <div className="min-w-0 flex-1">
            {title}
            {meta}
          </div>
          <div className="relative z-10 shrink-0">{action}</div>
        </div>
        {description ? (
          <p className="line-clamp-2 text-muted-foreground text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
    </li>
  );
}
