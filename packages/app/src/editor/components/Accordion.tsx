/**
 * Accordion — DIY renderer for the 5-pack foundation.
 *
 * Standalone expand/collapse via native HTML5 `<details>`/`<summary>` — no
 * `<Accordions>` parent wrapper required. Renders the descriptor's 6-prop
 * surface: `title` (required), `defaultOpen`, `icon` (namespaced lucide),
 * `description`, `id`, `name` (for HTML5 exclusive-accordion grouping), plus
 * `children` (PM-managed NodeViewContent slot).
 *
 * ── Constraints (load-bearing) ───────────────────────────────
 *
 *   - NO `variant` prop → Notion color-map absorption deferred.
 *   - STANDALONE → no parent wrapper required. Exclusive grouping via HTML5
 *     `<details name="group">` (Chrome 120+, Safari 17.2+, Firefox 130+);
 *     siblings sharing a name auto-close each other on open.
 *   - HTML5 native collapse/expand → no JS state, no Radix-style animation
 *     machine, no toggle handler. Rotation on open/close via CSS transform
 *     keyed on the `[open]` attribute.
 *   - Matches Mintlify Accordion surface + HTML5 `name` attr; diverges from
 *     Fumadocs's Radix-requires-parent pattern.
 *
 * ── `children` semantics ─────────────────────────────────────────────────────
 *
 * `hasChildren: true` on the descriptor. The summary carries icon + title +
 * optional description as non-editable chrome (contentEditable=false). Body
 * renders inside `.accordion-body` unconditionally — browsers display:none
 * the content when `[open]` is unset, but PM's DOM is retained so children
 * stay live per Precedent #30 (all user content visible / editable).
 *
 * Zero upstream-docs-lib React imports — all styling flows
 * through the `[data-component-type="accordion"]` selector in globals.css
 * with OK shadcn semantic tokens.
 */

import { ChevronRight } from 'lucide-react';
import { resolveLucideIcon } from './lucide-icon-allowlist.ts';

interface AccordionProps {
  title?: string;
  defaultOpen?: boolean;
  /** Namespaced lucide identifier (e.g. `lucide:Rocket`). */
  icon?: string;
  description?: string;
  id?: string;
  /** HTML5 <details name=> group identifier. Siblings sharing a name auto-close each other. */
  name?: string;
  children?: React.ReactNode;
}

/**
 * DIY Accordion. Descriptor-dispatched via `componentMap['Accordion']`.
 *
 * The summary is marked `contentEditable={false}` so PM doesn't try to
 * manage it. Clicking the summary triggers the browser's native toggle
 * behavior; the CSS chevron rotation is keyed on the `[open]` attribute.
 */
export function Accordion(props: AccordionProps) {
  const IconOverride = resolveLucideIcon(props.icon);

  return (
    <details
      className="accordion"
      data-accordion-icon={IconOverride ? 'custom' : undefined}
      open={props.defaultOpen}
      id={props.id}
      name={props.name}
    >
      <summary className="accordion-summary" contentEditable={false}>
        <ChevronRight size={14} className="accordion-chevron" aria-hidden="true" />
        {IconOverride ? (
          <IconOverride size={16} className="accordion-icon" aria-hidden="true" />
        ) : null}
        <span className="accordion-title-group">
          <span className="accordion-title">{props.title ?? 'Accordion'}</span>
          {props.description ? (
            <span className="accordion-description">{props.description}</span>
          ) : null}
        </span>
      </summary>
      <div className="accordion-body">{props.children}</div>
    </details>
  );
}
